"""译文质量闸门。返回 (是否通过, 失败原因)，全部本地可算。

阈值取向：误杀好译文比放过坏译文更烦，所以整体偏宽，
只拦明显的问题：空、未翻译、复读、加戏、截断、中文残留。
"""

from __future__ import annotations

import re

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{2,}")

MIN_WORDS_PER_CJK = 0.35   # 中文 1 字 → 英文至少 0.35 词
MAX_WORDS_PER_CJK = 2.2    # 超过就是加戏 / 幻觉
MAX_CJK_IN_OUTPUT = 0.08   # 目标英文里残留中文上限
MIN_RATIO_SOURCE_CJK = 4   # 源文太短时不做下限判断（"好的" → "OK" 是合法的）


def judge(source: str, output: str, target: str) -> tuple[bool, str]:
    out = output.strip()
    if out == "":
        return False, "empty"
    if out == source.strip():
        return False, "unchanged"

    if target.startswith("en"):
        if len(CJK_RE.findall(out)) / max(len(out), 1) > MAX_CJK_IN_OUTPUT:
            return False, "cjk-leftover"
        src_cjk = len(CJK_RE.findall(source))
        # 源文的"信息量"：汉字数 + 拉丁词数（"修复 bug" 算 3 个单位，不是 2）
        units = src_cjk + len(LATIN_WORD_RE.findall(source))
        words = len(WORD_RE.findall(out))
        # 上界对短句也生效，否则 "修复 bug。" 能被译成一整段废话
        if words > max(6.0, units * MAX_WORDS_PER_CJK):
            return False, "too-long"
        if src_cjk >= MIN_RATIO_SOURCE_CJK and words < units * MIN_WORDS_PER_CJK:
            return False, "too-short"
        if _repeat_ratio(out) > 0.45:
            return False, "repetition"
    return True, ""


def _repeat_ratio(text: str) -> float:
    words = text.lower().split()
    if len(words) < 12:
        return 0.0
    grams = [tuple(words[i:i + 3]) for i in range(len(words) - 2)]
    return 1 - len(set(grams)) / len(grams)
