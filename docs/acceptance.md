# 验收手册

> 对应版本 v0.1.0。最近一次完整执行：2026-10-25，全部通过，证据见各节末尾。
> 需求基线见 [spec-v2.0-original.md](spec-v2.0-original.md) 的 4.5（DSH）与 5.6（ChatGPT）清单。

## 0. 前置条件

```powershell
cd <仓库目录>
pwsh -File tools\install.ps1          # 首次：装私有 Python 3.12 + 引擎依赖 + 模型 + 扩展依赖
pwsh -File tools\start-engine.ps1 -Background   # 或前台运行
pwsh -File tools\health-check.ps1
```

引擎只监听 `127.0.0.1:5000`；模型约 164 MB，`.venv` 约 109 MB，都在项目目录内，删除目录即卸载。

## 1. 自动验收

| # | 命令 | 期望 | 覆盖 |
|---|------|------|------|
| 1 | `node test/run.ts` | `pass 59 / fail 0` | 格式保护、分段、约束词、设置、DSH/ChatGPT 适配器、IME、文本提取、manifest 权限姿态 |
| 2 | `node test/integration.local.ts` | `pass 3 / fail 0`，并打印真实中英译文 | 真实引擎链路：代码块/缩进/行内代码/路径逐字还原、中译英与英译中 |
| 3 | `node test/corpus.local.ts` | `corpus: 34/34 ok, 0 failed`，并写 `.artifacts/corpus-report.json` | 34 条真实提示词语料回归 |
| 4 | `pwsh -File tools\health-check.ps1` | `ALL 5 CHECKS PASSED` | `/health`、`/languages`、中英双向翻译、`/detect` |
| 5 | `node node_modules\typescript\bin\tsc --noEmit` | 无输出（退出码 0） | 类型检查 |
| 6 | `pwsh -File scripts\build.ps1` | `built -> dist`，列出 5 个文件 | 构建 |
| 7 | `pwsh -File scripts\package.ps1` | 打印 zip 路径与 sha256；拒绝出包条件见脚本注释 | 发布打包与校验 |

> 命令 1–3 用 `node <file>` 直接执行，而不是 `node --test`：后者会为每个测试文件派生带管道 stdio 的子进程，在 DSH 沙箱里会 `EPERM`。

最近一次证据（2026-10-25）：

```
ℹ tests 59   ℹ pass 59   ℹ fail 0
ℹ pass 3     ℹ fail 0            （integration）
corpus: 34/34 ok, 0 failed, 8.8s
ALL 5 CHECKS PASSED
typecheck exit=0
release: LinguaBridge-0.1.0.zip  82 KB extension / 24 KB archive
```

## 2. 浏览器自测页（无需 DSH 登录）

```powershell
pwsh -File tools\mock-ui.ps1      # 前台，Ctrl+C 停止
# 打开 http://127.0.0.1:8765/dsh-mock.html
```

该页复刻 DSH 的真实标记（`data-conversation-scroll`、`data-chat-anchor-key`、`data-composer-seat`、`data-lexical-editor`、`data-slot`、`data-turn-tail`），因此内容脚本会自动激活。

| 检查项 | 操作 | 期望 |
|--------|------|------|
| 回复卡片 | 打开页面并等待 ~2 秒 | 英文回复下方出现「本地译文」卡片，可折叠/复制；原消息不变 |
| 用户行不误译 | 看第一条中文用户消息 | 其下方**没有**译文卡片 |
| 对比面板 | 点「填入示例中文提示词」→ `Ctrl+Alt+T` | 面板显示原文（含代码块）与英文译文；meta 显示 provider、耗时、还原片段数、版本号 |
| 格式还原 | 对照面板里的代码块 | 缩进、函数名、`` `npm test` ``、`C:\work\report.md` 与原文逐字一致 |
| 约束提示 | 观察面板顶部 | 出现「注意事项」：否定词/保持类要求可能被弱化 |
| 写入 | 点「写入输入框」 | 面板提示已写入；输入框内容为译文；**不会自动发送** |
| IME | 在输入框用拼音输入，组合过程中按 `Ctrl+Alt+T` | 不触发翻译，提示"输入法正在组合中"；候选词确认后输入完好 |
| 流式回复 | 点「模拟流式回复」 | 文本停止变化后只出现**一张**卡片（不是每帧一张） |
| 断网引导 | 停掉引擎后再翻译 | 面板报"连不上本地翻译服务"并给出启动命令；输入框内容不变 |

最近一次证据：2026-10-25 在 jsdom 中对同一份 fixture 执行适配器断言通过（`test/adapters.test.ts`）；真实浏览器点击验证由使用者完成。

## 3. DSH 真实页面

前提：扩展运行在 **Chrome/Edge 标签页**里。DSH 桌面版（Electron）无法加载扩展，且其 Web UI 只接受启动时打印的带 token 链接。

```powershell
npx -y @deepseek-ai/dsh web
# 打开终端打印的 http://127.0.0.1:<port>/?token=...
```

| # | 检查项 | 期望 |
|---|--------|------|
| 1 | 中文拼音输入法组合期间 | 不误触发翻译、不破坏输入、不产生拼音碎片 |
| 2 | `Ctrl+Alt+T` | 面板显示原文/译文对比 |
| 3 | 点「写入输入框」 | DSH 状态机识别草稿；可直接按 Enter 发送 |
| 4 | 提示词含代码块与路径 | 写入后格式与原文完全一致 |
| 5 | 助手回复完成后 | 回复下方出现「本地译文」卡片；代码复制、折叠、工具调用展示不受影响 |
| 6 | 停掉本地服务后翻译 | 明确提示并给出启动指引，绝不自动发送 |
| 7 | 禁用扩展 | DSH 输入与发送完全正常 |

## 4. ChatGPT

| # | 检查项 | 期望 |
|---|--------|------|
| 1 | 中文 → 英文提示词 | 可翻译、可确认、可写入/发送 |
| 2 | 代码块、URL、行内代码 | 不被破坏 |
| 3 | 输入法组合期间 | 不误触发 |
| 4 | 翻译失败 | 不自动发送 |
| 5 | 回复 | 双语展示，原文可完整复制 |
| 6 | 禁用扩展 | 站点功能无影响 |

> 状态：适配器已实现（textarea 与 contenteditable 两代结构），**尚未在真实站点验收**。

## 5. 打包与加载

```powershell
pwsh -File scripts\package.ps1
# 解压 release\LinguaBridge-<version>.zip，得到 LinguaBridge-<version>/ 目录
# edge://extensions 或 chrome://extensions → 开发人员模式 → 加载解压缩的扩展 → 选择该目录
```

期望：扩展出现在列表里，`127.0.0.1` 页面右侧出现圆形「译」按钮；`release\LinguaBridge-<version>.json` 中的逐文件 SHA-256 与实际文件一致（打包脚本已自动回读校验）。

## 6. 问题回报模板

```
版本：面板 meta 里的 vX.Y.Z（或 chrome://extensions 里的版本号）
站点：DSH（端口 / 是否 dsh web 起的） / ChatGPT / 自测页
现象：期望什么 · 实际什么
复现步骤：
1.
2.
页面片段：出问题的消息行或输入区的 outerHTML（脱敏后）
扩展控制台：chrome://extensions → 该扩展 → service worker / 页面 console 的报错
引擎日志：.logs\engine-5000.log（只含请求行，不含正文）
```

回复提取类问题请特别附上**出错行的 HTML 片段**——适配器依赖 `data-slot` / `data-turn-tail` 等标记判断行类型，改版时这些标记的变化就是定位依据。
