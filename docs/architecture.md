# 架构与实现决策

> 对应版本：v0.1.0（2026-10-25）。需求基线见 [spec-v2.0-original.md](spec-v2.0-original.md)。

## 1. 数据流

```
┌──────────────────────────── 浏览器标签页 ────────────────────────────┐
│  DSH Web UI / ChatGPT                                                │
│      │                                                               │
│      ├─ content.js                                                   │
│      │   ├─ sites/dsh.ts | sites/chatgpt.ts   站点适配器             │
│      │   ├─ ime.ts                            IME 守卫               │
│      │   ├─ dom.ts                            编辑器读写 + 回读校验  │
│      │   └─ ui/panel.ts                       对比面板 / 译文卡片    │
│      │                    （Shadow DOM，站点 CSS 与快捷键都隔离）    │
│      │                                                               │
│      │ chrome.runtime.sendMessage                                    │
│      ▼                                                               │
│  background.js（Service Worker，唯一持有 host 权限、唯一发 HTTP）    │
│      │  fetch 127.0.0.1:5000                                         │
└──────┼───────────────────────────────────────────────────────────────┘
       ▼
  service/server.py（标准库 HTTP，LibreTranslate 兼容 API）
       └─ service/engine.py（CTranslate2 + SentencePiece + Argos 模型）
```

设计约束：**页面 CSP、CORS、混合内容规则都不作用于 Service Worker**，所以网络请求一律放在后台；内容脚本只做 DOM 与人机确认。

## 2. 与方案的差异（全部由实测驱动）

| 方案假设 | 实测发现 | 最终实现 | 证据 |
|----------|----------|----------|------|
| DSH 运行在 `127.0.0.1:3080` | 端口启动时动态选择；本机实例是 `52252` | 适配器按 DOM 标记识别站点，完全不看端口 | `GET http://127.0.0.1:52252/` 返回页面；`netstat` 显示 52252 监听 |
| 用占位符替换受保护片段，翻译后还原 | Argos 把 `[[1]]` 压成 `[1]`；`{{2}}` 变 `{{2}`；整行被幻觉成 `[ Chuckles ]`；占位符常被直接丢弃 | **放弃占位符**：在每个受保护片段处切开文本，只翻译片段之间的自然语言，再按原顺序拼回 | `docs` 内不含原始探针，但 `src/core/pipeline.ts` 顶部注释记录了结论；`test/protect.test.ts` 保留 `[3]` 等探针结论 |
| 部署完整 LibreTranslate（`pip install libretranslate`） | 其依赖链拉入 torch（数 GB 级），与本机 Python 3.14 也不兼容 | 自研轻量服务：只装 ctranslate2 + sentencepiece（约 32 MB），加载**同一批** Argos 模型，对外仍是 LibreTranslate 兼容 API | `service/engine.py`；`pwsh tools\health-check.ps1` 5 项通过 |
| Python 3.11 环境 | 本机仅有 Python 3.14，而 Argos/CT2 轮子面向 ≤3.12 | 用 `uv` 把 CPython 3.12 装进项目内 `.python`，不污染系统 | `tools/install.ps1`；`.python/cpython-3.12.15-*` |
| 输入框是 contenteditable，可 `textContent` 赋值 | 赋值会让 Lexical 内部状态与 DOM 脱节 | 优先 `document.execCommand("insertText")` 走 `beforeinput` 通道，写完**回读比对**，不一致则降级并如实报告失败 | `src/content/dom.ts#writeToEditable`；jsdom 测试覆盖降级路径 |
| 回复可用角色属性定位 | DSH **没有** `data-message-role` 一类属性 | 用"排除"法：排除用户行（`data-slot="conversation.chat.user.content"`、`data-submission-echo`）、元数据行（`data-turn-tail`、`turn-tail`）、思考与轨迹槽位，剩下的行里优先含 markdown 正文者 | 扫描 `app.asar` 得到属性清单，见第 4 节 |
| DSH Web UI 可直接在浏览器打开 | 每个进程随机生成 launch token，`GET /` 返回 401，只有带 `?token=` 的首次请求会换签名 cookie；桌面版是 Electron 窗口，无法加载扩展 | 记录为使用前提：真实页面验收需自行 `dsh web` 并在浏览器打开；另提供复刻 DOM 的自测页 | `dsh web authentication required; reopen the URL printed by dsh web.` |

## 3. 关键设计

### 3.1 格式保护是结构性的，不是"祈祷模型别丢"

`mask()` 先把代码块、行内代码、URL、邮箱、路径、命令、环境变量、`{{模板}}`、以及用户自己写的 `[[n]]` 替换为占位符，`toSegments()` 再把遮罩文本切成"文本段 / 受保护段"交替序列。管线只把**文本段**送给引擎，受保护段直接从原串拷贝。

因此"格式 100% 还原"不依赖模型行为，而是拼接时的事实；`runPipeline()` 末尾仍有一次自检（每个受保护段必须在结果里原文出现），失败即抛错、拒绝写入。

两处细节：

- **边界拼接**：中文原文在代码两侧通常没有空格，直译后英文会粘在一起（`npm test`And write…）。拼接时若两侧都是拉丁字符则补一个空格，并把译文里的全角标点转成半角（`。，；：！？`），但**只作用于自然语言段**，绝不碰代码。
- **片段过短不送引擎**：纯标点或纯符号的片段保持原样，避免把 `，` 单独送去翻译。

### 3.2 失败策略：保留原文、明确原因、绝不发送

引擎不可达 / 超时 / 空译文 / 格式自检失败 → 面板显示错误与启动指引，输入框保持原样。写入与发送永远由用户点击触发；`allowAutoSend` 默认 `false`，目前没有代码路径会绕过点击。

超时按长度分档：≤120 字符 8 秒，长文本按配置放大，上限 30 秒。

### 3.3 IME 守卫

在 `document` 捕获阶段监听 `compositionstart` / `compositionend` / `blur`，组合期间与 `compositionend` 后 60 ms 冷却期内：不读取编辑器、不写入、不自动翻译回复。这是"拼音碎片"问题的根因防线。

### 3.4 写入与发送

- 优先在编辑器内 `selectNodeContents` → `delete` → `insertText`，让站点收到与真人输入同形的 `beforeinput`/`input`。
- 含换行时先整体写入，失败再按 `insertLineBreak` 逐行重试。
- 最后兜底 `textContent` + `InputEvent`，并**回读校验**；不一致就向用户报错而不是假装成功。
- 发送：优先点击站点自己的提交按钮（DSH 为 `[data-composer-card] button[type=submit]`，ChatGPT 为 `[data-testid="send-button"]`），否则模拟 Enter 序列。

### 3.5 回复卡片

- 提取后的文本作为独立卡片插在消息行**之后**，不改动原 DOM，因此代码复制、折叠、工具调用展示不受影响。
- 卡片在 Shadow DOM 内，可折叠、可复制，带"注意事项"角标。
- 去重键：`data-chat-node-key` → `data-chat-anchor-key` → 内容哈希。流式回复靠"文本稳定 ~1.2–1.4 秒后再翻译"判定完成，同一键只保留一张卡（新结果替换旧卡）。
- 页面载入时额外做一次首屏检查：已存在的回复不会触发 MutationObserver，需要主动翻译一次。

### 3.6 权限与隐私

- `host_permissions` 只有四项：`127.0.0.1`、`localhost`、`chatgpt.com`、`chat.openai.com`；`permissions` 只有 `storage`、`contextMenus`、`activeTab`。由 `test/manifest.test.ts` 断言，改坏了会红。
- 引擎只绑定 `127.0.0.1`，不监听局域网；服务端日志只记方法/路径/状态，不记请求体。
- 扩展不落历史（`saveHistory` 默认 `false`）。

## 4. DSH DOM 锚点（扫描 `app.asar` 实测）

| 属性 | 含义 | 用途 |
|------|------|------|
| `[data-composer-seat]` / `[data-composer-card]` | 输入区容器 | 定位输入框与发送按钮 |
| `[data-lexical-editor="true"]` | Lexical 可编辑根 | 读写草稿 |
| `[data-conversation-scroll]` | 消息区滚动容器 | MutationObserver 观察范围 |
| `[data-chat-anchor-key]` / `[data-chat-node-key]` | 消息行 / 节点键 | 行枚举与去重键 |
| `[data-chat-flow-kind]` / `[data-chat-turn]` | 行类型 / 轮次 | 排除 `turn-tail` |
| `[data-turn-tail]` | token 用量与操作栏所在行 | 排除（否则会误当回复） |
| `[data-slot="conversation.chat.user.content"]` | 用户消息正文槽 | 排除用户行 |
| `[data-submission-echo]` | 刚发出消息的回显行 | 排除 |
| `[data-slot^="conversation.chat.reasoning"]` | 模型思考 | 不计入译文 |
| `[data-slot^="conversation.trajectory"]` | 执行轨迹 | 不计入译文 |
| `[data-chat-call-id]` | 工具调用卡片 | 不计入译文 |

`SlotOutlet` 会把插槽键渲染为 `data-slot` 属性（`display: contents` 的锚点），上表里以 `data-slot` 开头的项都来自这一机制。

## 5. 消息协议

| 消息 | 方向 | 说明 |
|------|------|------|
| `lb:translate` | content → background | 携带 `TranslationRequest`，返回译文/警告/受保护片段数，或明确的失败类型（`unreachable` / `timeout` / `http` / `empty` / `format-integrity`） |
| `lb:health` | content → background | 探测 `/health`，返回端点、延迟、语言对是否齐备 |
| `lb:ping` | content → background | 取扩展版本号，显示在面板 meta 里，便于问题回报 |
| `lb:command` | background → content | 快捷键 / 右键菜单触发的命令（`translate-prompt`、`translate-selection`） |

## 6. 模块职责

| 文件 | 职责 |
|------|------|
| `src/core/protect.ts` | 保护规则、占位符、分段 |
| `src/core/pipeline.ts` | 保护 → 逐段翻译 → 拼接 → 自检 |
| `src/core/constraints.ts` | 约束词与否定检测（10 组规则） |
| `src/core/provider.ts` | `TranslationProvider` 接口 + LibreTranslate 兼容实现、超时、错误分类 |
| `src/core/settings.ts` | 设置模型、校验、存储 |
| `src/core/messaging.ts` | 消息契约与发送封装 |
| `src/background/index.ts` | 唯一 HTTP 出口、右键菜单、快捷键转发、健康徽标 |
| `src/content/index.ts` | 控制器：触发、面板、回复调度、去重 |
| `src/content/dom.ts` | 编辑器读写与回读校验 |
| `src/content/ime.ts` | IME 守卫 |
| `src/content/text.ts` | 消息文本提取（保留代码换行、跳过按钮/卡片） |
| `src/content/sites/*.ts` | 站点适配器 |
| `src/content/ui/panel.ts` | 对比面板、启动按钮、译文卡片 |
| `service/engine.py` | CT2 模型加载、分句、批翻译、去 tokenize |
| `service/server.py` | LibreTranslate 兼容 HTTP 层、CORS、错误映射 |

## 7. 已知取舍

1. **质量**：Argos 是传统 NMT，复杂否定与长句指代会走样；因此把"原文对照 + 手动确认"做成产品底线，而不是可选功能。
2. **分段翻译的代价**：跨片段上下文丢失，片段化后偶发生硬（`完成后运行` → "Run after completion"）；术语表会加剧切分。
3. **未实现**：OpenCC 简繁（`chineseVariant` 目前只是配置项）、设置页、ChatGPT 回复完成检测的进一步加固、托盘程序。
4. **ChatGPT 侧未经真实站点验收**：选择器取自公开稳定属性，但站点改版需回归。
