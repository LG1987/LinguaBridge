"""LibreTranslate-compatible HTTP wrapper around the local CTranslate2 engine.

Endpoints used by the extension:
    POST /translate   {q, source, target, format}
    GET  /languages
    POST /detect
    GET  /health

Design notes:
  * binds 127.0.0.1 by default — the plan forbids LAN exposure;
  * request bodies are never logged (prompts are private);
  * runs on the standard library only, so the install stays small.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from engine import Engine, ModelMissingError, UnsupportedLanguageError, detect_language
from gateway import Gateway, GlmProvider, LocalProvider

VERSION = "0.3.0"
STARTED_AT = time.time()
MAX_BODY_BYTES = 4 * 1024 * 1024


def load_provider_config() -> dict[str, Any]:
    """GLM 的 key / model / base_url：环境变量优先，其次 providers.local.json（不入库）。"""
    config: dict[str, Any] = {}
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "providers.local.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                config = loaded
        except (OSError, json.JSONDecodeError) as error:
            sys.stderr.write(f"providers.local.json ignored: {error}\n")

    config["glm_api_key"] = os.environ.get("LB_LLM_KEY") or config.get("glm_api_key", "")
    return config


def build_gateway(engine: Engine, config: dict[str, Any]) -> Gateway:
    providers: list[Any] = []
    if config.get("glm_api_key"):
        providers.append(
            GlmProvider(
                base_url=str(config.get("glm_base_url") or "https://open.bigmodel.cn/api/paas/v4"),
                api_key=str(config["glm_api_key"]),
                model=str(config.get("glm_model") or "glm-4-flash"),
            )
        )
    providers.append(LocalProvider(engine))
    return Gateway(providers)


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = f"LinguaBridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    engine: Engine  # injected by create_server
    gateway: Gateway  # injected by create_server

    # ---- plumbing --------------------------------------------------
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Log method/path/status/duration only — never the body."""
        sys.stderr.write(
            "%s - %s\n" % (time.strftime("%H:%M:%S"), format % args)
        )

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body too large")
        raw = self.rfile.read(length)
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type == "application/json":
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, f"invalid JSON body: {error}") from error
            if not isinstance(parsed, dict):
                raise ApiError(HTTPStatus.BAD_REQUEST, "JSON body must be an object")
            return parsed
        # Form-encoded (what LibreTranslate's own docs use).
        try:
            form = parse_qs(raw.decode("utf-8"), keep_blank_values=True)
        except UnicodeDecodeError as error:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"invalid form body: {error}") from error
        return {key: values[-1] for key, values in form.items()}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- routes ----------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path == "/health":
                self._send_json(HTTPStatus.OK, self._health_payload())
            elif path == "/languages":
                self._send_json(HTTPStatus.OK, self.engine.languages_payload())
            elif path in ("/", "/index.html"):
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "name": "LinguaBridge local engine",
                        "version": VERSION,
                        "endpoints": ["/translate", "/detect", "/languages", "/health"],
                        "note": "LibreTranslate-compatible subset backed by Argos/CTranslate2.",
                    },
                )
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, f"unknown endpoint: {path}")
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except Exception as error:  # pragma: no cover - defensive
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            payload = self._read_payload()
            if path == "/translate":
                self._handle_translate(payload)
            elif path == "/detect":
                self._handle_detect(payload)
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, f"unknown endpoint: {path}")
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except ModelMissingError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except UnsupportedLanguageError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
        except Exception as error:  # pragma: no cover - defensive
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"internal error: {error}"})

    # ---- handlers --------------------------------------------------
    def _handle_translate(self, payload: dict[str, Any]) -> None:
        text = payload.get("q")
        if isinstance(text, list):
            raise ApiError(HTTPStatus.BAD_REQUEST, "batch input is not supported; send one q at a time")
        if not isinstance(text, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "q (text to translate) is required")

        source = str(payload.get("source") or "auto")
        target = payload.get("target")
        if not isinstance(target, str) or target.strip() == "":
            raise ApiError(HTTPStatus.BAD_REQUEST, "target language is required")

        translation, provider_name, cached = self.gateway.translate(text, source=source, target=target)
        if translation.strip() == "" and text.strip() != "":
            raise ApiError(HTTPStatus.INTERNAL_SERVER_ERROR, "engine returned an empty translation")

        self._send_json(
            HTTPStatus.OK,
            {
                "translatedText": translation,
                "detectedLanguage": {"language": self._detected(text, source), "confidence": 90},
                "provider": provider_name,
                "cached": cached,
            },
        )

    @staticmethod
    def _detected(text: str, source: str) -> str:
        if source not in ("auto", "", None):
            return source
        return detect_language(text)[0]

    def _handle_detect(self, payload: dict[str, Any]) -> None:
        text = payload.get("q")
        if not isinstance(text, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "q (text) is required")
        language, confidence = detect_language(text)
        self._send_json(HTTPStatus.OK, [{"language": language, "confidence": confidence}])

    def _health_payload(self) -> dict[str, Any]:
        pairs = [f"{source}->{target}" for source, target in self.engine.available_pairs()]
        return {
            "status": "ok" if pairs else "no-models",
            "version": VERSION,
            "engine": "argos-ctranslate2",
            "models": pairs,
            "providers": [provider.name for provider in self.gateway.providers if provider.available()],
            "uptimeSeconds": round(time.time() - STARTED_AT, 1),
            "loaded": sorted(self.engine._bundles.keys()),  # noqa: SLF001 - simple status
        }


def create_server(host: str, port: int, engine: Engine, gateway: Gateway) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"engine": engine, "gateway": gateway})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LinguaBridge local translation service")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default: loopback only)")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument(
        "--models",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"),
        help="directory containing the Argos model packages",
    )
    parser.add_argument("--compute-type", default="int8", choices=["auto", "int8", "int8_float32", "float32"])
    parser.add_argument("--beam-size", type=int, default=2)
    parser.add_argument("--preload", action="store_true", help="load all models before serving")
    args = parser.parse_args(argv)

    engine = Engine(args.models, compute_type=args.compute_type, beam_size=args.beam_size)
    pairs = engine.available_pairs()
    if not pairs:
        sys.stderr.write(
            f"No models found under {args.models}.\nRun: python tools/fetch_argos_models.py\n"
        )
        return 2
    if args.preload:
        loaded = engine.load_all()
        sys.stderr.write(f"preloaded: {', '.join(loaded)}\n")

    config = load_provider_config()
    gateway = build_gateway(engine, config)
    online = any(name != "argos-local" for name in (provider.name for provider in gateway.providers))
    if online:
        print("  online layer: glm-4-flash enabled (set LB_OFFLINE=1 to force offline)", flush=True)
    else:
        print("  online layer: disabled (no key / LB_OFFLINE=1), local engine only", flush=True)

    server = create_server(args.host, args.port, engine, gateway)
    print(f"LinguaBridge engine {VERSION} listening on http://{args.host}:{args.port}", flush=True)
    print(f"  models: {', '.join(f'{s}->{t}' for s, t in pairs)}", flush=True)
    print(f"  health: http://{args.host}:{args.port}/health", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
