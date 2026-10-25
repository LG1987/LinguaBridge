# LinguaBridge 0.1.0 软件包

本目录是用 `scripts/package.ps1` 产出的**可分发扩展包**，直接入库以便下载即用（无需 Node/Python 工具链即可加载）。

| 文件 | 大小 | 说明 |
|------|------|------|
| `LinguaBridge-0.1.0.zip` | 24 KB | 解压后即「加载解压缩的扩展」目录，顶层目录名 `LinguaBridge-0.1.0/` |
| `LinguaBridge-0.1.0.json` | 0.8 KB | 构建时间、逐文件大小与 SHA-256、整包 SHA-256、加载说明 |

整包 SHA-256：`5257cc1d306dd2450b8b067efad41d839c86e867894a11420ff9421fa197e799`
（以同名 `.json` 为准，每次重新打包都会更新。）

解压后共 3 个文件、83,746 字节：

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3 清单：名称/版本、权限、注入范围、快捷键、Service Worker 入口 |
| `background.js` | Service Worker：唯一持有 host 权限、唯一向 `127.0.0.1` 发 HTTP 的模块；负责翻译编排、健康探测、右键菜单、快捷键转发、工具栏徽标 |
| `content.js` | 注入脚本：站点适配器（DSH / ChatGPT）、IME 守卫、原文对比面板、译文卡片 |

> 包内**不含** sourcemap、TypeScript 源码、测试或依赖；已由打包脚本回读校验。

---

## 这个包能做什么

### 1. 中文提示词 → 英文（先确认，再发送）

- 在输入框写好中文，按 `Ctrl + Alt + T`（macOS `Command + Alt + T`）或点页面右侧圆形「译」按钮。
- 弹出**原文 / 译文对比面板**：上半部是原文（只读、可选中复制），下半部是**可编辑**的英文译文。
- 面板按钮：
  - **复制译文** — 复制到剪贴板
  - **重译** — 用同一段原文重新请求
  - **写入输入框** — 写入后**不发送**，由你按 Enter
  - **写入并发送** — 写入并点击站点自己的发送按钮（这一步就是你的确认）
- 写入后会回读比对，页面没接受就明确报错，绝不"假装写成功"。

### 2. 格式保护（代码不会被翻坏）

以下内容**根本不会发给翻译引擎**，而是从原串直接拼回：

- 围栏代码块（```` ```ts ```` / `~~~`，含未闭合的）
- 行内代码（`` `npm test` ``）
- 网址、邮箱
- Windows 路径（`C:\work\report.md`）、UNC 路径、相对文件路径（`src/core/provider.ts`）
- 常见命令（`git commit -m '...'`、`npm run build`、`docker run ...`）
- 环境变量（`$env:NODE_ENV`、`${HOME}`、`%PATH%`）
- `{{模板变量}}`
- 你自己输入的 `[[1]]` 这类占位符样式文本

因此代码缩进、函数名、URL 在译文里与原文逐字一致；面板 meta 会显示「已还原 N 处代码/链接」。

### 3. 约束词提示（防止语气被削弱）

翻译后自动比对原文里的强约束表达，发现可能丢失时在面板顶部列出「注意事项」：

必须 / 不得 / 禁止 / 只输出 / 仅限 / 至少·最多 / 除非·否则 / 保持·不要修改 / 一步一步 / 指定输出语言 / 指定输出格式，另加否定词数量粗检。

这些提示不阻断操作，但会明确摆在眼前——Argos 属传统 NMT，复杂约束确实会走样。

### 4. AI 回复 → 中文（双语对照）

- 助手回复完成后，在其**下方**插入一张独立的「本地译文」卡片（标题栏显示耗时与引擎）。
- 卡片可**折叠**、可**复制**；**不覆盖原消息 DOM**，所以原文的代码复制、折叠、工具调用展示都不受影响。
- 流式回复只在文本稳定后插入**一张**卡；同一回复更新时替换而不是堆叠。
- 自动跳过：你自己的提问行、你刚发出的回显行、token 用量等元数据行、模型思考与执行轨迹。

### 5. 输入法安全

中文/日文/韩文输入法**组合输入期间**（以及候选词确认后 60 ms 内）不读取、不写入编辑器、不自动翻译。这是"拼音碎片"问题的根因防线。

### 6. 其它

| 功能 | 说明 |
|------|------|
| 右键菜单 | 选中任意文本 →「用 LinguaBridge 翻译选中文本（本地）」，作为适配器失效时的降级通道 |
| 工具栏徽标 | `✓` 表示本地服务可达，`!` 表示连不上；点图标刷新 |
| 健康检查 | 打开页面时探测本地服务，不可达会在「译」按钮的提示里给出启动指引 |
| 版本号 | 面板 meta 里显示 `v0.1.0`，便于问题回报 |
| 失败策略 | 服务不可达 / 超时 / 空译文 / 格式自检失败 → 保留原文 + 明确原因 + **绝不自动发送** |

---

## 安装

1. 解压 `LinguaBridge-0.1.0.zip`，得到 `LinguaBridge-0.1.0/` 目录（内含 `manifest.json`）。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启「开发人员模式」。
3. 点「加载解压缩的扩展」，选择该目录。
4. 打开受支持页面，右侧出现圆形「译」按钮即安装成功。

## 运行依赖

| 依赖 | 要求 |
|------|------|
| 浏览器 | Chrome / Edge **116+**（`minimum_chrome_version`） |
| 本地引擎 | 本包**不含**引擎。需在仓库根目录执行 `pwsh -File tools\install.ps1` 安装（私有 Python 3.12 + CTranslate2 + 约 164 MB 的 Argos 中英模型），再 `pwsh -File tools\start-engine.ps1` |
| 引擎地址 | 默认 `http://127.0.0.1:5000`，仅监听回环地址 |
| 网络 | 翻译全程不出本机；只有首次安装模型时需要联网 |

## 权限（最小集）

- `permissions`：`storage`（保存设置与术语表）、`contextMenus`（右键菜单）、`activeTab`
- `host_permissions`：`http://127.0.0.1/*`、`http://localhost/*`、`https://chatgpt.com/*`、`https://chat.openai.com/*`

不申请 `<all_urls>`，不读取其它网站。这四条由 `test/manifest.test.ts` 断言，改动会红。

## 校验与复现

```powershell
# 校验下载完整性（对比 .json 里的 archiveSha256）
Get-FileHash .\LinguaBridge-0.1.0.zip -Algorithm SHA256

# 从源码重新生成同样的包
pwsh -File scripts\package.ps1

# 校验解压后的结构（应输出 3 个文件、manifest 版本 0.1.0、无 .ts/.map）
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead(".\LinguaBridge-0.1.0.zip").Entries | Select-Object FullName, Length
```

## 本包不包含 / 已知限制

- 不含本地引擎、模型与安装脚本（见上表），`service/` 与 `tools/` 在仓库源码里。
- 不含 sourcemap，因此控制台堆栈是压缩后的行号；排查适配器问题时请以面板行为与页面 HTML 片段为准。
- DSH **桌面版**（Electron）无法加载浏览器扩展，且其 Web UI 只接受 `dsh web` 打印的 `?token=` 链接；真实页面验收请用浏览器打开 `dsh web` 的地址，或先用 `tools\mock-ui.ps1` 的自测页验证交互层。
- Argos 属传统 NMT：复杂否定、长句指代、专业术语可能走样；术语表会切碎句子，偶发漏词。手动确认面板就是为此存在，不建议绕过。
- ChatGPT 适配器为 beta，未在真实站点验收。
- 简繁转换（OpenCC）与设置页尚未实现。
