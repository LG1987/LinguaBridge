# 免费混合翻译方案（v0.3 提案）

> 前提：**不引入任何本地大模型**。不装 Ollama，不下载 7B，不占显存。
> 成本目标：**0 元**。全部依赖免费额度 + 现有 Argos 引擎。
> 依据：v0.2.5 源码实读（`service/engine.py`、`service/server.py`、`src/core/pipeline.ts`、`dsh-plugin/linguabridge-send/client.js`）。

---

## 0. 一句话结论

把 `service/server.py` 从「Argos 直通」改成**本地网关**：一次请求按 `免费 LLM → 免费传统 MT → 本地 Argos` 三层降级，网关内做缓存 + 质量闸门 + 术语表。插件端只改 2 处，总成本 0 元。

---

## 1. 现状诊断

| # | 问题 | 位置 | 后果 |
|---|------|------|------|
| 1 | 引擎是 Argos / OPUS-MT，CTranslate2 int8 | `service/engine.py:194` | 质量天花板：机翻腔、长句断裂、术语漂移 |
| 2 | 逐段串行调用，一段一次往返 | `client.js:178-194` | 段间上下文全丢；N 段 = N 次 HTTP |
| 3 | 无术语表 | `client.js` | 同一术语前后译法不一致 |
| 4 | 无质量闸门 | `client.js:157` | 只要非空就接受，坏译文照样发出去 |
| 5 | 已是英文仍送引擎 | `client.js:172`（`HAS_TRANSLATABLE` 含 `A-Za-z`） | 多余往返，还可能被 en→en 改写 |
| 6 | 引擎没启动 = 硬失败 | `client.js:163` | 无兜底，功能直接不可用 |
| 7 | 强制 6s 载入动画 | `client.js:25`（`MIN_LOADER_MS`） | 每次发送至少等 6 秒（顺手修） |

**根因判断**：扩展侧 `src/core/pipeline.ts` 已经有「已是英文跳过 / 术语表 / 约束检查 / 格式完整性自检」，插件侧 `client.js` 是另写的一套简化实现，这些全丢了。插件准确率比扩展差，不是因为插件调用方式特殊，而是因为**两套实现分叉了**。

---

## 2. 架构

```
DSH 插件 (client.js)
   │  POST 127.0.0.1:5000/translate  (或 /translate/batch)
   ▼
本地网关 (service/gateway.py)
   ├─ ① 缓存 (SQLite)        命中直接返回，0 调用
   ├─ ② 免费 LLM API         质量最好；额度耗尽/超时自动跳过
   ├─ ③ 免费传统 MT          额度大、稳、快
   └─ ④ 本地 Argos           离线兜底，永久免费
        ↓
   质量闸门 (service/quality.py)   不达标 → 降到下一层 → 全挂才报错
```

**为什么网关放服务端，而不是插件直连第三方：**

1. 插件跑在页面上下文，直连第三方 API 会撞 CORS / CSP；
2. API key 不能写进前端代码；
3. 缓存、降级、术语表、额度统计全在服务端，插件零改动；
4. 以后换 provider 不用重新发插件。

**代价**：本机第一次要出网。见 §8 产品定位处理。

---

## 3. 改造清单

### 3.1 新增 `service/quality.py`（约 60 行）

纯本地计算，不调外部服务。四项硬指标：

```python
"""译文质量闸门。返回 (是否通过, 失败原因)，全部本地可算。"""
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
```

阈值先用这套跑，用 `test/corpus.local.ts` 的 34 条语料回调。别一开始调太严，误杀好译文比放过坏译文更烦。

> 已用 9 条样例回归：好译文 5 条全过，截断 / 未翻译 / 复读 / 加戏 4 条全拦。

阈值先用这套跑，用 `test/corpus.local.ts` 的 34 条语料回调。别一开始调太严，误杀好译文比放过坏译文更烦。

### 3.2 新增 `service/cache.py`（约 50 行）

```python
"""SQLite 译文缓存：同一句 + 同一链路版本只翻一次。"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS translations (
  key TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
  provider TEXT NOT NULL, output TEXT NOT NULL, created_at REAL NOT NULL
);
"""


class TranslationCache:
    def __init__(self, path: str, chain_version: str, ttl_days: int = 90) -> None:
        self._lock = threading.Lock()
        self._ttl = ttl_days * 86400
        self._version = chain_version          # 换 provider 后 bump，旧缓存自动失效
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(SCHEMA)
        self._db.commit()

    def _key(self, text: str, source: str, target: str) -> str:
        raw = f"{self._version}\x00{source}\x00{target}\x00{text}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def get(self, text: str, source: str, target: str):
        with self._lock:
            row = self._db.execute(
                "SELECT output, provider, created_at FROM translations WHERE key = ?",
                (self._key(text, source, target),),
            ).fetchone()
        if row is None or time.time() - row[2] > self._ttl:
            return None
        return row[0], row[1]

    def put(self, text, source, target, output, provider) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO translations VALUES (?,?,?,?,?,?)",
                (self._key(text, source, target), source, target, provider, output, time.time()),
            )
            self._db.commit()
```

### 3.3 新增 `service/gateway.py`（约 180 行）

只用 stdlib（`urllib.request`），不新增依赖，延续你「无 torch / 无 Flask」的取向。

```python
"""翻译网关：免费 LLM → 免费 MT → 本地 Argos，逐层降级。"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request

from quality import judge

TIMEOUT_S = 8.0
LANG_NAMES = {"en": "English", "zh": "Chinese"}


class ProviderError(RuntimeError):
    pass


def _post_json(url, body, headers, timeout):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class LlmProvider:
    """OpenAI 兼容接口：智谱 / 硅基流动 / 百炼 都按这个形状调。"""

    def __init__(self, name, base_url, api_key, model, timeout=TIMEOUT_S):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key) and os.environ.get("LB_OFFLINE") != "1"

    def translate(self, text, target, glossary=None) -> str:
        system = (
            "You are a translation engine. Translate the user's text into "
            f"{LANG_NAMES.get(target, target)}. Rules: output ONLY the translation; "
            "preserve the original line breaks and the original NUMBER OF LINES; "
            "never add explanations, quotes or markdown; keep numbers, identifiers "
            "and code exactly as written."
        )
        if glossary:
            system += " Glossary (MUST follow): " + "; ".join(
                f"{k} => {v}" for k, v in glossary.items()
            )
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
            return data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as error:
            raise ProviderError(f"{self.name}: unexpected response") from error


class MyMemoryProvider:
    """免费、无需 key，用来先把链路跑通。额度约 5000 词/天。"""

    name = "mymemory"

    def available(self) -> bool:
        return os.environ.get("LB_OFFLINE") != "1"

    def translate(self, text, target, glossary=None) -> str:
        source = "zh-CN" if re.search(r"[\u4e00-\u9fff]", text) else "en"
        pair = f"{source}|{'en-GB' if target.startswith('en') else target}"
        url = (
            "https://api.mymemory.translated.net/get?q="
            + urllib.parse.quote(text)
            + f"&langpair={pair}"
        )
        data = _get_json(url, TIMEOUT_S)
        out = (data.get("responseData") or {}).get("translatedText") or ""
        if out.strip() == "":
            raise ProviderError("mymemory: empty")
        return out.strip()


class LocalProvider:
    name = "argos-local"

    def __init__(self, engine) -> None:
        self.engine = engine

    def available(self) -> bool:
        return True

    def translate(self, text, target, glossary=None) -> str:
        out, _detected = self.engine.translate(text, source="auto", target=target)
        return out


class Gateway:
    def __init__(self, providers, cache):
        self.providers = providers
        self.cache = cache

    def translate(self, text, source, target, glossary=None):
        cached = self.cache.get(text, source, target)
        if cached is not None:
            return cached[0], cached[1], True

        failures = []
        for provider in self.providers:
            if not provider.available():
                continue
            try:
                out = provider.translate(text, target, glossary)
            except Exception as error:                 # 网络、额度、解析一律降级
                failures.append(f"{provider.name}: {error}")
                continue
            ok, reason = judge(text, out, target)
            if not ok:
                failures.append(f"{provider.name}: quality={reason}")
                continue
            self.cache.put(text, source, target, out, provider.name)
            return out, provider.name, False

        raise ProviderError("all providers failed | " + "; ".join(failures))

    def translate_batch(self, segments, source, target, glossary=None):
        """LLM 层一次译完所有片段以保留上下文；行数不符就退回逐段。"""
        joined = "\n".join(segments)
        for provider in self.providers:
            if not provider.available():
                continue
            try:
                out = provider.translate(joined, target, glossary)
            except Exception:
                continue
            lines = out.split("\n")
            if len(lines) != len(segments):
                continue
            if any(not judge(src, dst, target)[0] for src, dst in zip(segments, lines) if src.strip()):
                continue
            return lines, provider.name

        return [self.translate(seg, source, target, glossary)[0] for seg in segments], "per-segment"
```

### 3.4 修改 `service/server.py`（3 处）

```python
# 1) 启动时装配网关（main 里 engine 构造之后）
from cache import TranslationCache
from gateway import Gateway, LlmProvider, LocalProvider, MyMemoryProvider

chain = [
    LlmProvider("zhipu-glm-flash", "https://open.bigmodel.cn/api/paas/v4",
                os.environ.get("LB_LLM_KEY", ""), "glm-4-flash"),
    MyMemoryProvider(),
    LocalProvider(engine),
]
gateway = Gateway(chain, TranslationCache("./.logs/cache.db", chain_version="v1"))

# 2) _handle_translate 第 156 行替换
translation, provider, cached = self.gateway.translate(text, source, target)
# 响应里加两个字段，方便排查是哪一层给的
#   "provider": provider, "cached": cached

# 3) 新增 POST /translate/batch  {segments: [...], source, target} → {translations: [...]}
```

`/translate` 的请求/响应形状保持不变，插件不用改协议。

### 3.5 修改 `client.js`（2 处）

```js
// ① 已是英文直接跳过（对齐 pipeline.ts:168 的行为）
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
if (!HAS_CJK.test(text)) return text;

// ② translateDraft 里：先收集所有待译片段，再一次批量请求
const pending = [];
for (const segment of segmentize(text)) {
  if (segment.keep) { /* 原样保留 */ }
  else if (/* 有可译字符 */) pending.push(segment.value.trim());
}
const { translations } = await fetch(`${base}/translate/batch`, { ... });
```

10 段文本从 10 次往返降到 1 次，且 LLM 能看到全文，指代关系不再断。

---

## 4. 免费额度清单

| 层 | Provider | 免费额度 | 需 key | 备注 |
|----|----------|----------|--------|------|
| ① | 智谱 GLM-4-Flash | 免费（限并发） | 是 | 中文理解最好，**首选** |
| ① | 硅基流动 SiliconFlow | 部分模型免费 | 是 | OpenAI 兼容，换个 base_url 就能接 |
| ① | 阿里百炼 qwen-flash | 新用户百万 token | 是 | 同上 |
| ② | 腾讯云 TMT | 每月大额度字符 | 是 | 传统 MT，快且稳 |
| ② | 百度翻译标准版 | 约 5 万字符/月 | 是 | 额度小，只当备胎 |
| ② | MyMemory | 约 5000 词/天 | 否 | **不用 key，先拿它验证链路** |
| ③ | 本地 Argos | 无限 | 否 | 离线兜底 |

> 额度以各官网当前政策为准，别写死进代码。key 放环境变量或 `service/providers.local.json`（加进 `.gitignore`）。

---

## 5. 上下文问题怎么解决

- **LLM 层**：所有片段按行拼成一次请求，模型能看见句间指代。回来校验行数，不符就退回逐段。
- **Argos 层**：保持现有切开策略。它是逐句解码的，硬塞上下文没用，还会让输出变长。
- **占位符**：只在 LLM 层可用。你们在 `pipeline.ts` 顶部记录过 Argos 会丢 `[[1]]` 甚至幻觉成 `[ Chuckles ]` —— 那个结论对 Argos 成立，对 LLM 不成立。这层不要一刀切。

---

## 6. 落地节奏

| 步骤 | 工作量 | 做什么 | 怎么验收 |
|------|--------|--------|----------|
| Step 1 | 半天 | `quality.py` + `cache.py` + 网关只挂 MyMemory 和 Argos | 同一句翻两次，第二次外部调用 0 次；故意喂坏译文，闸门拦下并降级 |
| Step 2 | 半天 | 接 GLM-4-Flash 放第一层，key 走环境变量 | 跑 `test/corpus.local.ts` 34 条语料盲评，明显优于 Argos 的条目 > 70% |
| Step 3 | 2 小时 | `client.js` 改批量 + 英文跳过；顺手把 `MIN_LOADER_MS` 从 6000 降到 800 | 10 段文本往返次数 10 → 1；发送等待不再固定 6s |

---

## 7. 验收标准

- 34 条语料人工评分 ≥ 4/5 的条目占比 > 80%
- 重复提示词场景缓存命中率 > 30%
- 10 段以内 P95 端到端 < 3s
- 任意一层挂掉不影响可用性（降级成功，不报错给用户）
- `node test/run.ts` 现有 59 个测试全绿

---

## 8. 产品定位怎么不被打脸

README 写的是「全程只访问 127.0.0.1，不调用任何付费 API」。加了在线层之后：

- **默认离线**：`LB_OFFLINE=1` 或设置项开关，默认走纯本地 Argos，文案不变；
- **在线增强是显式开关**：用户自己打开，UI 上写明「会把待译文本发送到第三方」；
- **不付费**：只挂免费额度层，不接任何付费接口。

这样「本地优先」的定位没变，只是多了一个可选的质量层。

---

## 9. 明确不做的事

| 不做 | 原因 |
|------|------|
| 本地大模型（7B / Ollama） | 你已否掉；且 MX150 2G 显存跑不动，纯负担 |
| 对 Argos 用占位符替换 | 实测会丢、会幻觉，`pipeline.ts` 已记录 |
| 直连 Google 翻译非官方接口 | 不稳定，违反 ToS，随时挂 |
| 自建公网 LibreTranslate 实例 | 要服务器成本，且文本出网不可控 |
| 一次性重写插件 | 两套实现分叉才是准确率差的根因，先把 `pipeline` 的核心逻辑抽成共享模块 |

---

## 10. 一条长期建议

`client.js` 和 `src/core/pipeline.ts` 现在是两份平行实现，改一处漏一处。把 protect / 术语表 / 质量闸门抽成一个不依赖 DOM 的共享模块（`pipeline.ts` 已经声明「Kept free of DOM and chrome APIs」，本来就能直接给插件用），插件只保留 UI 和提交逻辑。这一步做完，以后所有翻译质量的改进对扩展和插件同时生效。
