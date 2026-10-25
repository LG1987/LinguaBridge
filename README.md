# LinguaBridge

本地优先的中英双语输入层：把中文提示词翻译成英文，**先看原文与译文对比，再决定是否写入输入框**；同时把 AI 的英文回复翻译成中文，作为独立卡片插在回复下方。全程只访问 `127.0.0.1`，不调用任何付费 API。

DSH（DeepSeek Harness）优先适配，兼容 ChatGPT。

**当前版本：v0.2.4**（最新）— 插件触发方式只有「译」按钮（撤销了 0.2.2 的 Enter 接管）；动画常驻、去掉白色底板、6s 滑动。v0.2.0 引入 **DSH 原生插件「译并发送」**；扩展与引擎行为不变。变更记录见 [CHANGELOG.md](CHANGELOG.md)，版本定义见 [docs/releases/](docs/releases/)。

**两种交付形态**

| 形态 | 适用 | 产物 |
|------|------|------|
| 浏览器扩展 | Chrome/Edge 打开 DSH Web UI 或 ChatGPT | `LinguaBridge-extension-<version>.zip` |
| DSH 原生插件 | 直接装在 DSH 桌面版/Web 的输入区（无需浏览器扩展） | `LinguaBridge-dsh-plugin-<version>.zip` |

**文档**：[原始方案](docs/spec-v2.0-original.md) · [架构与实现决策](docs/architecture.md) · [验收手册](docs/acceptance.md) · [需求变更 RC-001](docs/requirement-changes.md) · [变更记录](CHANGELOG.md)

---

## 当前状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 | 本地翻译引擎（Argos 中英模型 + CTranslate2）、健康检查 | ✅ 已验证 |
| P1 | Provider 抽象、格式保护、原文对比确认 UI、MV3 扩展骨架 | ✅ 已验证（单元 + 集成） |
| P2 | DSH 适配器：Lexical `contenteditable` 读写、IME 保护、发送 | ✅ 逻辑已验证（jsdom），真实页面待人工验收 |
| P3 | DSH 回复双语卡片 | ✅ 逻辑已验证，真实页面待人工验收 |
| P4 | ChatGPT 适配器 | 🟡 已实现，未在真实站点验收 |
| P5 | 两站回归 | ⏳ 待人工验收 |
| P6 | OpenCC 简繁、术语表增强 | ⏳ 术语表已可用；简繁转换未做 |
| P7 | 桌面托盘程序 | ⏳ 未开始 |

已验证的证据（可复现）：

- `node test/run.ts` → **59 个单元 / DOM / 配置测试全部通过**（含真实自测页 fixture、manifest 权限姿态）
- `node test/corpus.local.ts` → **34 条真实提示词语料，0 失败**（代码块、行内代码、URL、路径、命令、约束词、否定、长文本）
- `node test/integration.local.ts` → **3 个真实引擎链路测试通过**
- `pwsh -File tools/health-check.ps1` → **5 项健康检查通过**

---

## 架构

```
浏览器 (DSH / ChatGPT)
  └─ content.js  ← 站点适配器 + IME 守卫 + 对比面板 / 译文卡片
        │ chrome.runtime.sendMessage
  └─ background.js (Service Worker，持有 host 权限)
        │ fetch 127.0.0.1:5000（页面 CSP / CORS 都不影响）
  └─ 本地引擎 service/server.py（标准库 HTTP，LibreTranslate 兼容 API）
        └─ CTranslate2 + Argos zh↔en 模型（无 torch、无 stanza）
```

关键设计：**受保护的代码/链接从不发给翻译引擎**。文本在每个受保护片段处切开，只翻译片段之间的自然语言，再按原顺序拼回。这样"格式 100% 还原"是结构性保证，而不是"祈祷模型别丢占位符"。

> 实测结论：Argos 会把 `[[1]]` 占位符丢掉、压成 `[1]`，甚至整段幻觉成 `[ Chuckles ]`。这正是放弃占位符替换方案的原因，见 `src/core/pipeline.ts` 顶部注释。

---

## 快速开始（Windows 11）

```powershell
cd D:\Users\16770\Documents\LinguaBridge

# 1) 一次性安装：私有 Python 3.12 + 引擎依赖 + 中英模型 + 扩展构建
pwsh -File tools\install.ps1

# 2) 后台启动本地引擎（只绑定 127.0.0.1:5000）
pwsh -File tools\start-engine.ps1 -Background

# 3) 自检
pwsh -File tools\health-check.ps1
```

### 加载扩展

1. 打开 `edge://extensions`（或 `chrome://extensions`）
2. 打开「开发人员模式」
3. 「加载解压缩的扩展」→ 选择 **`dist`** 目录
4. 打开 DSH Web UI，页面右侧出现圆形「译」按钮即安装成功

> 改动代码后重新构建：`pwsh -File scripts\build.ps1`，然后在扩展页点「重新加载」。

### 没有 DSH 登录也能先验证交互层

DSH **桌面版**的 Web UI 只接受 `dsh web` 启动时打印的 `?token=...` 链接（换签名 cookie 后重定向），而 Electron 窗口本身无法加载浏览器扩展——扩展必须跑在 Chrome/Edge 标签页里。为了不被这一步卡住，仓库里带了一个复刻 DSH DOM 标记的自测页：

```powershell
pwsh -File tools\mock-ui.ps1     # 前台运行，Ctrl+C 停止
# 打开 http://127.0.0.1:8765/dsh-mock.html
```

该页面使用真实标记（`data-conversation-scroll`、`data-chat-anchor-key`、`data-composer-seat`、`data-lexical-editor`、`data-slot`、`data-turn-tail`），因此内容脚本会自动激活，可以在真实浏览器里验证：

- 打开约 2 秒后，英文回复下方自动出现「本地译文」卡片（可折叠 / 复制）
- 「填入示例中文提示词」后按 `Ctrl+Alt+T`，验证原文/译文对比面板、格式保护与约束词提示
- 「写入输入框」后光标回到输入框，可在其中继续用拼音输入，验证 IME 不被破坏
- 「模拟流式回复」验证：只在文本停止变化后插入**一张**卡片，而不是每帧一张

> 这验证的是扩展的交互层与适配器选择器；Lexical 内部状态机、DSH 真实发送链路仍需在 `dsh web` 的浏览器标签页里做最终验收。

---

## 使用方式

| 操作 | 说明 |
|------|------|
| `Ctrl + Alt + T` | 翻译当前输入框（面板里对比原文/译文） |
| 右侧「译」按钮 | 同上，鼠标操作 |
| 右键菜单「用 LinguaBridge 翻译选中文本」 | 翻译任意选中文本（降级通用模式） |
| 面板「写入输入框」 | 写入后**不发送**，由你按 Enter |
| 面板「写入并发送」 | 写入并点击站点自己的发送按钮（这一步就是你的确认） |
| 回复翻译 | DSH/ChatGPT 的英文回复稳定后自动插入「本地译文」卡片，可折叠、可复制，**不改动原消息 DOM** |

输出语言与目标语言可在设置里改（见下文）。默认：提示词译成英文，回复译成中文。

---

## 不可妥协的底线（已实现）

| 门禁 | 实现 |
|------|------|
| 手动确认 | 默认 `inputMode: manual`，面板永远显示原文；不存在"输入即发送" |
| 格式保护 | 代码块/行内代码/URL/邮箱/路径/命令/环境变量/`{{模板}}` 一律不进引擎；重组后自检，丢失即抛 `FormatIntegrityError` 并拒绝写入 |
| 失败不发送 | 引擎不可达、超时、空译文、格式校验失败 → 保留原文 + 明确错误 + 启动指引，绝不静默发送 |
| 约束词检测 | 必须/不得/只输出/至少/除非/保持… 共 10 组规则 + 否定词数量粗检，异常在面板顶部列出 |
| IME 保护 | 组合输入期间（含 `compositionend` 后 60ms 冷却）禁止读写编辑器、禁止自动翻译 |
| 隐私 | 引擎只绑定 `127.0.0.1`；后台日志不记录请求体；`saveHistory` 默认关闭 |
| 最小权限 | `host_permissions` 仅 `127.0.0.1` / `localhost` / `chatgpt.com` / `chat.openai.com` |

---

## 发布打包

```powershell
pwsh -File scripts\package.ps1                  # 扩展：构建 + 校验 + 打包（-Tag extension）
pwsh -File scripts\package-plugin.ps1           # DSH 插件：校验 + 打包（无构建步骤）
pwsh -File scripts\package.ps1 -Version 0.2.1   # 改版本号后重新打包
pwsh -File scripts\package.ps1 -SkipBuild       # 复用当前 dist
```

产物在 `release/`（**已入库**，可直接下载，无需先构建）。从 v0.2.0 起文件名带**组件标识**：

| 文件 | 内容 |
|------|------|
| `LinguaBridge-extension-<version>.zip` | 扩展包，解压即「加载解压缩的扩展」（已排除 sourcemap） |
| `LinguaBridge-dsh-plugin-<version>.zip` | DSH 插件包，解压后把顶层目录作为 `install_bundle` 的 target |
| `LinguaBridge-<component>-<version>.json` | 构建时间、逐文件与整包 SHA-256、安装说明 |
| [`README.md`](release/README.md) | 发布物说明：命名约定、包内文件职责、功能清单、安装与校验 |

> v0.1.0 的历史产物保留原名 `LinguaBridge-0.1.0.zip`（tag `v0.1.0` 指向它），未重命名。

打包脚本会在以下情况**拒绝出包**：manifest 版本与 `package.json` 不一致、manifest 引用的 bundle 缺失、压缩包里混入 `.ts`/`.map`/测试文件。已实测校验：3 个文件、82 KB、逐文件哈希与元数据一致。

> 版本号同时出现在三处并保持一致：`package.json`（真源）、构建时写入 `dist/manifest.json`、`release/` 元数据。`src/manifest.json` 里的 `0.0.0` 是占位符，由构建覆盖——`test/manifest.test.ts` 会断言这一点。

---

## 配置

设置存放于 `chrome.storage.local` 的 `linguabridge.settings.v1`，默认值见 `src/core/settings.ts`：

```ts
{
  localEndpoint: "http://127.0.0.1:5000",
  sendTargetLanguage: "en",      // 提示词译成什么语言
  readingLanguage: "zh",         // 回复译成什么语言
  chineseVariant: "simplified",  // 简繁偏好（OpenCC 后处理待实现）
  inputMode: "manual",           // 强制手动确认
  responseMode: "bilingual",     // 回复双语卡片
  autoTranslateResponse: true,
  preserveCode: true,
  timeoutMs: 15000,              // 短文本 8s，长文本按长度放大，上限 30s
  glossary: [],                  // [{ "source": "泛型", "target": "generics" }]
  allowAutoSend: false
}
```

临时改配置（控制台执行，`chrome://extensions` 里选中扩展的 background 页面）：

```js
chrome.storage.local.get("linguabridge.settings.v1", (v) => console.log(v));
chrome.storage.local.set({ "linguabridge.settings.v1": { ...v["linguabridge.settings.v1"], localEndpoint: "http://127.0.0.1:5001" } });
```

> 设置页（options UI）尚未实现，属于后续阶段。

---

## 已知限制（诚实版）

1. **Argos 质量有限**：复杂否定、长句指代、专业术语容易走样。实测「只补充注释」会被译成 "but only a comment"。所以强制手动确认是产品核心，不是可选装饰。
2. **术语表会切碎句子**：术语被当作受保护片段切开后，模型看到的是短片段，偶尔会漏词（实测 `请解释 TypeScript 泛型` 中 `TypeScript` 在片段化后被丢掉）。术语表默认空；需要时建议同时给 `target`。
3. **分段翻译的边界感**：代码片段两侧的中文会被单独翻译，可能略显生硬（如「完成后运行」→ "Run after completion"）。已在拼接时补空格、把全角标点转半角。
4. **简繁转换未实现**：`chineseVariant` 目前只是配置项，OpenCC 后处理待补（P6）。
5. **ChatGPT 适配未在真实站点验证**：选择器基于 `#prompt-textarea`、`[data-message-author-role]` 等公开稳定属性，但站点改版需回归。
6. **DSH 端口是动态的**：本机实例实际监听 `127.0.0.1:52252`（方案文档里写的 3080 只是示例）。因此适配器**按 DOM 标记判断站点**，不依赖端口。
7. **DSH Web UI 需要鉴权**：桌面版每个进程随机生成 launch token，只接受 `?token=` 链接（换签名 cookie 后重定向），直接 `GET /` 返回 401。扩展必须运行在 Chrome/Edge 标签页中，因此想要真实页面验收，需要用 `npx -y @deepseek-ai/dsh web` 自己起一个 Web 实例并打开它打印的 URL；否则先用 `tools\mock-ui.ps1` 的自测页验证交互层。
8. **回复行提取仍依赖若干启发式**：DSH 没有 `data-message-role` 这类角色属性，适配器靠"排除用户行（`data-slot="conversation.chat.user.content"` / `data-submission-echo`）+ 排除元数据行（`data-turn-tail`）+ 优先含 markdown 正文的行"来定位助手回复。若 DSH 改版导致选错行，面板里会看到明显不对的原文，请回报。

---

## 目录结构

```
LinguaBridge/
├─ src/
│  ├─ manifest.json          MV3 清单
│  ├─ background/index.ts    Service Worker：唯一发 HTTP 的地方
│  ├─ core/
│  │  ├─ protect.ts          代码/链接/路径保护 + 分段
│  │  ├─ pipeline.ts         保护 → 翻译 → 重组 → 自检
│  │  ├─ constraints.ts      约束词/否定检测
│  │  ├─ provider.ts         LibreTranslateProvider（可替换）
│  │  ├─ settings.ts         设置与默认值
│  │  └─ messaging.ts        消息契约
│  └─ content/
│     ├─ index.ts            控制器：快捷键、面板、回复卡片
│     ├─ dom.ts              编辑器读写（execCommand 优先）+ 回读校验
│     ├─ ime.ts              IME 组合守卫
│     ├─ text.ts             消息文本提取
│     ├─ sites/dsh.ts        DSH 适配器
│     ├─ sites/chatgpt.ts    ChatGPT 适配器
│     └─ ui/panel.ts         对比面板 + 译文卡片（Shadow DOM）
├─ service/
│  ├─ engine.py              CTranslate2 + SentencePiece 引擎
│  ├─ server.py              LibreTranslate 兼容 HTTP 服务
│  └─ models/                Argos en_zh / zh_en（下载得到，不入库）
├─ scripts/build.ps1         沙箱内可用的构建入口（直接调 esbuild.exe）
├─ scripts/build.mjs         通用构建入口（npm run build，非沙箱环境）
├─ scripts/package.ps1       发布打包：校验 + 排除 sourcemap + 哈希元数据
├─ CHANGELOG.md              版本变更记录
├─ docs/                     开发文档（原方案 / 架构决策 / 验收手册）
├─ release/                  LinguaBridge-<version>.zip + 元数据（不入库）
├─ tools/
│  ├─ install.ps1            一键安装
│  ├─ start-engine.ps1       启动/停止引擎
│  ├─ mock-ui.ps1            浏览器自测页（无需 DSH 登录）
│  ├─ health-check.ps1       P0 验收
│  └─ fetch_argos_models.py  模型下载
└─ test/
   ├─ run.ts                 全部单元/DOM/配置测试（单进程）
   ├─ integration.local.ts   真实引擎链路测试
   ├─ corpus.local.ts        34 条语料回归
   ├─ manifest.test.ts       manifest 权限与版本姿态
   ├─ prompts/corpus.json    语料本体
   └─ fixtures/dsh-mock.html 复刻 DSH DOM 的浏览器自测页
```

---

## 开发

```powershell
# 构建（沙箱内用这个）
pwsh -File scripts\build.ps1

# 类型检查
node node_modules\typescript\bin\tsc --noEmit

# 单元 / DOM 测试（单进程，避免沙箱 spawn 限制）
node test\run.ts

# 真实引擎测试（需先启动引擎）
node test\integration.local.ts
node test\corpus.local.ts
```

### 本机环境上的三个坑（已在脚本里规避）

1. **沙箱禁止管道式子进程**：`npm install` 的生命周期脚本、`node --test` 的按文件子进程、esbuild 的 JS API 都会 `EPERM`。对应规避：`npm install --ignore-scripts`、`node test/run.ts` 单进程、`scripts/build.ps1` 直接调 `esbuild.exe`。
2. **Python 3.13+ 把 `mode=0o700` 变成真实 DACL**，`tempfile.mkdtemp` 创建的目录沙箱写不进去 → `.pyshim/sitecustomize.py` 忽略限制性 mode。
3. **系统只有 Python 3.14**：Argos/LibreTranslate 的轮子面向 ≤3.12，故用 `uv` 把 3.12 装进 `.python`，不碰系统环境。

### 排障

| 现象 | 处理 |
|------|------|
| `start-engine.ps1 -Background` 之后命令没有返回 | 该脚本用 `Start-Process` 派生进程；在把 stdout 接到管道的环境（IDE、DSH 托管 shell）里，父进程会等子进程的句柄。直接在普通 PowerShell 窗口前台运行 `pwsh -File tools\start-engine.ps1`，或换一个独立终端跑 `-Background`。 |
| 端口已被占用 / 想换端口 | `pwsh -File tools\start-engine.ps1 -Stop`（按端口定位真实监听进程，而不是只杀 venv 转发进程）；换端口用 `-Port 5001`，并在扩展设置里同步 `localEndpoint`。 |
| 扩展显示连不上引擎 | 先 `pwsh -File tools\health-check.ps1`；端口/地址确认后，再检查扩展的 `localEndpoint`。 |
| 面板里"原文"提取到了错误内容 | 说明所选行不是助手回复。可用 `tools\mock-ui.ps1` 的同类结构对照，并把页面 HTML 片段反馈回来调整选择器。 |

---

## 验收清单

### DSH（优先）

- [ ] 中文拼音输入法组合期间不误触发、不破坏输入
- [ ] `Ctrl+Alt+T` 打开面板，原文/译文对比正常
- [ ] 写入后 DSH 状态机识别草稿，可直接按 Enter 发送
- [ ] 代码块与文件路径完整保留（对照面板里肉眼确认）
- [ ] 回复译文卡片不破坏代码复制、折叠、工具调用展示
- [ ] 本地服务不可达时给出明确启动指引
- [ ] 禁用扩展后 DSH 输入与发送完全正常

### ChatGPT

- [ ] 中文 → 英文提示词翻译成功，确认后可发送
- [ ] 代码块、URL、行内代码不被破坏
- [ ] 输入法组合期间不误触发
- [ ] 翻译失败不自动发送
- [ ] 回复双语展示，原文可完整复制

---

## 下一步

1. 在真实 DSH 页面完成上表人工验收（需要已登录的浏览器标签页）
2. ChatGPT 回归与选择器加固
3. OpenCC 简繁后处理 + 术语表 UI
4. 设置页（endpoint、语言对、术语表、超时）
5. 可选：本地小尺寸翻译 LLM 作为第二 Provider（接口已就绪）
6. 托盘程序一键托管引擎
