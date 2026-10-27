"""翻译网关：GLM-4-Flash 优先，本地 Argos 保底。

设计约束：
- 只用 stdlib（urllib.request），不新增依赖；
- key 一律来自环境变量或 providers.local.json，绝不写进代码；
- 任何一层失败都降级到下一层，全挂才抛错；
- 同语言（如英文→英文）直接放行，不算"未翻译"。
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Callable

from engine import detect_language
from quality import judge

TIMEOUT_S = 12.0
LANG_NAMES = {"en": "English", "zh": "Chinese"}


class ProviderError(RuntimeError):
    pass


def _post_json(url: str, body: dict[str, Any], headers: dict[str, str], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class GlmProvider:
    """智谱 GLM（OpenAI 兼容接口）。base_url / key / model 都来自本地配置。"""

    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = TIMEOUT_S) -> None:
        self.name = f"glm:{model}"
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key) and os.environ.get("LB_OFFLINE") != "1"

    def translate(self, text: str, target: str, glossary: dict[str, str] | None = None) -> str:
        system = (
            "You are a translation engine. Translate the user's text into "
            f"{LANG_NAMES.get(target, target)}. Rules: output ONLY the translation; "
            "preserve the original line breaks and the original NUMBER OF LINES; "
            "never add explanations, quotes or markdown; keep numbers, identifiers, "
            "paths and code exactly as written; translate faithfully, do not "
            "summarize, paraphrase or omit any instruction."
        )
        if glossary:
            system += " Glossary (MUST follow): " + "; ".join(f"{k} => {v}" for k, v in glossary.items())

        data = _post_json(
            f"{self.base_url}/chat/completions",
            {
                "model": self.model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": text},
                ],
            },
            {"Authorization": f"Bearer {self.api_key}"},
            self.timeout,
        )
        try:
            return str(data["choices"][0]["message"]["content"]).strip()
        except (KeyError, IndexError, TypeError) as error:
            raise ProviderError(f"{self.name}: unexpected response") from error


class LocalProvider:
    """本地 Argos/CTranslate2 引擎，永久免费的离线兜底。"""

    name = "argos-local"

    def __init__(self, engine: Any) -> None:
        self.engine = engine

    def available(self) -> bool:
        return True

    def translate(self, text: str, target: str, glossary: dict[str, str] | None = None) -> str:
        out, _detected = self.engine.translate(text, source="auto", target=target)
        return out


class Gateway:
    def __init__(self, providers: list[Any], judge_fn: Callable[[str, str, str], tuple[bool, str]] = judge) -> None:
        self.providers = providers
        self.judge = judge_fn

    def translate(self, text: str, source: str, target: str, glossary: dict[str, str] | None = None):
        """返回 (译文, provider, cached)。cached 恒为 False（缓存留到下一版）。"""
        target_code = target.strip().lower() or "en"

        # 同语言直接放行：英文→英文不需要过引擎，也不该被质量闸门判"未翻译"。
        detected = detect_language(text)[0] if source in ("auto", "", None) else source
        if detected == target_code:
            return text, "passthrough", False

        failures: list[str] = []
        for provider in self.providers:
            if not provider.available():
                continue
            try:
                out = provider.translate(text, target_code, glossary)
            except Exception as error:  # 网络、额度、解析一律降级
                failures.append(f"{provider.name}: {error}")
                continue
            ok, reason = self.judge(text, out, target_code)
            if not ok:
                failures.append(f"{provider.name}: quality={reason}")
                continue
            return out, provider.name, False

        raise ProviderError("all providers failed | " + "; ".join(failures))
