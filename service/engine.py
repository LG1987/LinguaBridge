"""Argos / CTranslate2 translation engine.

This is the same model family LibreTranslate uses (Argos packages converted to
CTranslate2), but loaded directly: no torch, no stanza, no Flask. That keeps the
local install around 100 MB instead of ~2.5 GB while producing identical output.

The extension talks to `server.py`, which exposes a LibreTranslate-compatible
HTTP API, so swapping in the real LibreTranslate later is a configuration change.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import ctranslate2
import sentencepiece as spm

# Language codes LibreTranslate clients use for Chinese.
LANGUAGE_ALIASES = {
    "zh": "zh",
    "zt": "zh",  # LibeTranslate's code for traditional Chinese
    "zh-cn": "zh",
    "zh-tw": "zh",
    "zh-hans": "zh",
    "zh-hant": "zh",
    "cmn": "zh",
    "en": "en",
}

LANGUAGE_NAMES = {"zh": "Chinese", "en": "English"}

# SentencePiece word-boundary marker, and NLLB's "unknown token" marker.
WORD_BOUNDARY = "\u2581"
UNKNOWN_MARKER = "\u2047"

SENTENCE_SPLIT_RE = re.compile(r"[^。！？!?；;\n]+[。！？!?；;]?", re.UNICODE)
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
PAIRED_CJK_SPACE_RE = re.compile(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff])[ \t]+(?=[\u3400-\u4dbf\u4e00-\u9fff])")
SPACE_BEFORE_PUNCT_RE = re.compile(r"[ \t]+([,.!?;:%)])")
SPACE_AFTER_OPEN_RE = re.compile(r"([(])[ \t]+")

MAX_SEGMENT_CHARS = 360


class ModelMissingError(RuntimeError):
    """The requested translation direction has no model on disk."""


class UnsupportedLanguageError(RuntimeError):
    """The requested language code is not known to the engine."""


@dataclass
class ModelBundle:
    translator: ctranslate2.Translator
    tokenizer: spm.SentencePieceProcessor
    config: dict[str, Any]


def normalize_language(code: str) -> str:
    key = (code or "").strip().lower()
    if key not in LANGUAGE_ALIASES:
        raise UnsupportedLanguageError(f"unsupported language: {code!r}")
    return LANGUAGE_ALIASES[key]


def detect_language(text: str) -> tuple[str, float]:
    """Cheap deterministic detector: enough for zh/en, no model download."""
    sample = text[:2000]
    if not sample.strip():
        return "en", 0.0
    cjk = len(CJK_RE.findall(sample))
    visible = len(re.sub(r"\s", "", sample))
    if visible == 0:
        return "en", 0.0
    ratio = cjk / visible
    if ratio >= 0.2:
        return "zh", round(min(0.99, 0.5 + ratio / 2), 2)
    return "en", round(min(0.99, 0.5 + (1 - ratio) / 2), 2)


def split_segments(text: str) -> list[str]:
    """Split prose into engine-sized segments while keeping paragraph breaks.

    Empty lines are preserved as empty segments so joining restores the layout.
    """
    segments: list[str] = []
    for line in text.split("\n"):
        if line.strip() == "":
            segments.append("")
            continue
        pieces = [piece for piece in SENTENCE_SPLIT_RE.findall(line) if piece.strip() != ""]
        if not pieces:
            segments.append(line)
            continue
        buffer = ""
        for piece in pieces:
            if buffer and len(buffer) + len(piece) > MAX_SEGMENT_CHARS:
                segments.append(buffer)
                buffer = piece
            else:
                buffer += piece
        if buffer:
            segments.append(buffer)
    return segments


def detokenize(tokens: list[str]) -> str:
    """Join SentencePiece pieces back into text.

    `SentencePieceProcessor.decode(list)` leaves word-boundary markers intact for
    these packages, so the replacement is done explicitly.
    """
    text = "".join(tokens).replace(WORD_BOUNDARY, " ").replace(UNKNOWN_MARKER, "")
    text = SPACE_BEFORE_PUNCT_RE.sub(r"\1", text)
    text = SPACE_AFTER_OPEN_RE.sub(r"\1", text)
    return text.strip()


def tidy_chinese(text: str) -> str:
    """Remove the spaces an English-trained decoder leaves between Chinese glyphs."""
    return PAIRED_CJK_SPACE_RE.sub("", text)


class Engine:
    def __init__(
        self,
        models_dir: str,
        *,
        compute_type: str = "int8",
        beam_size: int = 2,
        max_decoding_length: int = 512,
    ) -> None:
        self.models_dir = os.path.abspath(models_dir)
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.max_decoding_length = max_decoding_length
        self._bundles: dict[str, ModelBundle] = {}
        self._lock = threading.Lock()
        self.loaded_at: float | None = None

    # ---- discovery -------------------------------------------------
    def available_pairs(self) -> list[tuple[str, str]]:
        pairs: list[tuple[str, str]] = []
        if not os.path.isdir(self.models_dir):
            return pairs
        for name in sorted(os.listdir(self.models_dir)):
            match = re.fullmatch(r"(en|zh)_(en|zh)", name)
            if match is None:
                continue
            source, target = match.group(1), match.group(2)
            if self._package_root(os.path.join(self.models_dir, name)) is not None:
                pairs.append((source, target))
        return pairs

    @staticmethod
    def _package_root(package_dir: str) -> str | None:
        """Argos packages nest their payload in one versioned directory."""
        if not os.path.isdir(package_dir):
            return None
        candidates = [
            entry
            for entry in os.listdir(package_dir)
            if os.path.isdir(os.path.join(package_dir, entry))
        ]
        for candidate in candidates:
            root = os.path.join(package_dir, candidate)
            if os.path.isfile(os.path.join(root, "model", "model.bin")):
                return root
        if os.path.isfile(os.path.join(package_dir, "model", "model.bin")):
            return package_dir
        return None

    # ---- loading ---------------------------------------------------
    def load(self, source: str, target: str) -> ModelBundle:
        key = f"{source}_{target}"
        cached = self._bundles.get(key)
        if cached is not None:
            return cached

        package_dir = os.path.join(self.models_dir, key)
        root = self._package_root(package_dir)
        if root is None:
            raise ModelMissingError(
                f"model {source}->{target} is not installed; run tools/fetch_argos_models.py"
            )

        translator = ctranslate2.Translator(
            os.path.join(root, "model"),
            device="cpu",
            compute_type=self.compute_type,
            inter_threads=1,
            intra_threads=max(1, min(8, (os.cpu_count() or 4))),
        )
        tokenizer = spm.SentencePieceProcessor(model_file=os.path.join(root, "sentencepiece.model"))
        with open(os.path.join(root, "model", "config.json"), "r", encoding="utf-8") as handle:
            config = json.load(handle)

        bundle = ModelBundle(translator=translator, tokenizer=tokenizer, config=config)
        self._bundles[key] = bundle
        return bundle

    def load_all(self) -> list[str]:
        loaded: list[str] = []
        for source, target in self.available_pairs():
            self.load(source, target)
            loaded.append(f"{source}->{target}")
        self.loaded_at = time.time()
        return loaded

    # ---- translation -----------------------------------------------
    def _prepare(self, bundle: ModelBundle, text: str) -> list[str]:
        tokens = bundle.tokenizer.encode(text, out_type=str)
        if bundle.config.get("add_source_bos"):
            tokens = [bundle.config["bos_token"], *tokens]
        if bundle.config.get("add_source_eos"):
            tokens = [*tokens, bundle.config["eos_token"]]
        return tokens

    def translate(self, text: str, source: str = "auto", target: str = "en") -> tuple[str, str]:
        """Translate `text`; returns (translation, detected_source_language)."""
        if text is None:
            raise ValueError("q is required")
        if text.strip() == "":
            return "", detect_language(text)[0]

        detected = detect_language(text)[0] if source in ("auto", "", None) else normalize_language(source)
        target_code = normalize_language(target)
        if detected == target_code:
            return text, detected

        bundle = self.load(detected, target_code)
        segments = split_segments(text)
        indexes = [index for index, segment in enumerate(segments) if segment.strip() != ""]
        if not indexes:
            return text, detected

        batch = [self._prepare(bundle, segments[index]) for index in indexes]
        # Long inputs may need more decoder steps than short ones.
        longest = max(len(tokens) for tokens in batch)
        max_length = min(self.max_decoding_length, max(64, longest * 3 + 24))

        started = time.perf_counter()
        with self._lock:
            results = bundle.translator.translate_batch(
                batch,
                beam_size=self.beam_size,
                max_decoding_length=max_length,
                replace_unknowns=False,
            )
        elapsed = time.perf_counter() - started

        translated: dict[int, str] = {}
        for position, result in enumerate(results):
            hypothesis = result.hypotheses[0] if result.hypotheses else []
            output = detokenize(hypothesis)
            translated[indexes[position]] = output

        parts: list[str] = []
        for index, segment in enumerate(segments):
            parts.append(translated.get(index, segment if segment.strip() == "" else ""))
        rendered = "\n".join(parts).strip()
        if target_code == "zh":
            rendered = tidy_chinese(rendered)

        self.last_elapsed_ms = round(elapsed * 1000, 1)
        return rendered, detected

    # ---- metadata --------------------------------------------------
    def languages_payload(self) -> list[dict[str, Any]]:
        targets: dict[str, list[str]] = {}
        for source, target in self.available_pairs():
            targets.setdefault(source, []).append(target)
        payload: list[dict[str, Any]] = []
        for code in sorted(targets):
            payload.append(
                {
                    "code": code,
                    "name": LANGUAGE_NAMES.get(code, code),
                    "targets": sorted(targets[code]),
                }
            )
        return payload
