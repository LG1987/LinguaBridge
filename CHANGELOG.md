# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。当前只发布扩展（服务为源码形式，随仓库更新）。

## [0.2.0] — 2026-10-25

第二版：新增 **DSH 原生插件「译并发送」**，扩展与本地引擎的既有接口和行为不变（向后兼容的 minor）。版本定义与改动方案见 [docs/releases/v0.2.0.md](docs/releases/v0.2.0.md)。

### 新增

- `dsh-plugin/linguabridge-send/`：DSH 客户端插件，在输入框右侧工具行加「译」按钮。点一次 = 读草稿（`InputState.draft`）→ 本机引擎译成英文 → `inputActions.setDraft` 写回 → 等投影发布 → `submit()`。会话里你自己的消息即英文。
- 插件内置与扩展同一套**结构性格式保护**：代码块、行内代码、URL、邮箱、路径、命令、环境变量、`{{模板}}` 不进引擎、直接拼回。
- `test/dsh-plugin.local.ts`：加载真实 `client.js`（React 钩子桩）并点击按钮，对真实引擎断言——正常链路、引擎不可达不发送、空草稿不发送。
- `docs/requirement-changes.md`：RC-001「发送即翻译」的需求定义、实测约束与四种方案取舍。
- `docs/releases/v0.2.0.md`：本版版本定义、改动方案、证据与回滚说明。
- `scripts/package-plugin.ps1`：插件打包与校验。

### 变更

- 发布物命名带**组件标识**：`LinguaBridge-extension-<version>.zip` / `LinguaBridge-dsh-plugin-<version>.zip`，各自配套 `.json` 元数据。
- `scripts/package.ps1` 新增 `-Tag`，用于生成带组件标识的文件名。

### 修复

- 插件读不到草稿：字段应为 `InputState.draft`（此前按 `clipboardText/text/value` 探测，恒为空）。
- 插件格式保护：多条规则独立收集区间时，"未闭合围栏"会匹配到已闭合的代码块并延伸到文末，导致其后的中文不翻译。重叠匹配现被跳过。

### 已知问题

- 插件仅覆盖**用户输入**的中→英；AI 回复译中文仍由浏览器扩展提供。
- 插件按"方案 A"落地：点的是新增的「译」按钮，而非原生发送键（原生键无公开拦截钩子，接管需替换 composer）。
- Argos 质量限制同 0.1.0；插件会改写草稿，撤销体验与原生不同。

## [0.1.0] — 2026-10-25

首个可运行版本，覆盖方案中的 P0–P3。

### 新增

**本地引擎（P0）**
- `service/`：CTranslate2 + Argos `zh↔en` 模型，只依赖 ctranslate2 / sentencepiece（约 32 MB，无 torch）
- LibreTranslate 兼容 API：`POST /translate`、`GET /languages`、`POST /detect`、`GET /health`
- 仅绑定 `127.0.0.1`；请求体不写日志
- 脚本：`install.ps1`（私有 Python 3.12 + 依赖 + 模型）、`start-engine.ps1`（含 `-Stop`）、`health-check.ps1`（5 项验收）

**扩展（P1–P3）**
- MV3 扩展，Service Worker 统一出网，页面 CSP/CORS 不影响翻译请求
- 原文/译文对比确认面板（Shadow DOM，可编辑译文、复制、重译、写入、写入并发送）
- 格式保护：代码块、行内代码、URL、邮箱、Windows/相对路径、shell 命令、环境变量、`{{模板}}`
- 约束词守卫：10 组规则（必须/禁止/只输出/排他/上下限/条件/保持/分步/语言/格式）+ 否定词数量粗检
- IME 守卫：组合输入期间及 `compositionend` 后 60 ms 内禁止读写编辑器
- DSH 适配器：`data-composer-seat` / `data-lexical-editor` 定位，`execCommand` 写入 + 回读校验，站点发送按钮/Enter
- DSH 回复双语卡片：排除用户行、回显行、`turn-tail` 元数据行、思考与工具调用后提取正文，插入可折叠/可复制卡片，流式回复只留一张卡
- ChatGPT 适配器（beta）：`#prompt-textarea`（textarea 与 contenteditable 两代结构）、`[data-message-author-role]`
- 降级通道：右键菜单翻译选中文本；`Ctrl+Alt+T` 快捷键

**工程与验收**
- 53 个单元 / DOM 测试（`node test/run.ts`，单进程，适配沙箱）
- 真实引擎链路测试 3 个、34 条中文提示词语料回归（`test/corpus.local.ts`）
- 浏览器自测页 `test/fixtures/dsh-mock.html` + `tools/mock-ui.ps1`，无需 DSH 登录即可验证交互层
- `scripts/package.ps1`：构建 → 校验 manifest → 排除 sourcemap → 打包 → 哈希与元数据

### 变更

- **放弃占位符还原方案**。实测 Argos 会把 `[[1]]` 丢成 `[1]`、或整段幻觉成 `[ Chuckles ]`，因此改为"在每个受保护片段处切开、只翻译片段之间的自然语言、再按原顺序拼回"。格式还原由此成为结构性保证，见 `src/core/pipeline.ts`。
- 修复围栏代码块正则吞掉后续正文的问题；修复后置规则吞掉前置占位符的问题（`curl <url>` 场景）。
- 移除未使用的 `scripting` 权限，保持最小权限集。

### 已知问题

- Argos 属传统 NMT：复杂否定、长句指代、专业术语仍可能走样；强制手动确认是产品底线。
- 术语表会把句子切碎，短片段上模型偶尔漏词（实测 `请解释 TypeScript 泛型` 中 `TypeScript` 被丢）。术语表默认空。
- DSH 桌面版 Web UI 使用一次性 `?token=` 鉴权，Chromium 扩展无法注入 Electron 窗口；真实页面验收需自行运行 `dsh web` 并在浏览器打开。
- ChatGPT 适配器未在真实站点验收。
- 未实现：OpenCC 简繁转换、设置页（options UI）、ChatGPT 回复完成检测的进一步加固。
