# LinguaBridge 发布物

本目录是用脚本产出的**可分发产物**，直接入库以便下载即用（无需 Node/Python 工具链即可安装）。从 **v0.2.0** 起，文件名带**组件标识**，避免"版本号对不上是哪个东西"。

## 命名约定

```
LinguaBridge-<component>-<version>.zip    # 产物
LinguaBridge-<component>-<version>.json   # 同名元数据：逐文件/整包 SHA-256、安装说明
```

| component | 是什么 | 怎么装 |
|-----------|--------|--------|
| `extension` | Chrome/Edge MV3 浏览器扩展 | 解压 → 扩展页「加载解压缩的扩展」→ 选顶层目录 |
| `dsh-plugin` | DSH 原生插件（Cordis bundle） | 解压 → 把顶层目录作为 `plugin_manager install_bundle` 的 target |

> v0.1.0 的历史产物保留原名 `LinguaBridge-0.1.0.zip`，对应 tag `v0.1.0`，未重命名。

## 当前产物（v0.2.1）

| 文件 | 大小 | SHA-256 | 内容 |
|------|------|---------|------|
| `LinguaBridge-extension-0.2.1.zip` | 24.1 KB | `6bd6843e…97bb` | 扩展：`manifest.json` + `background.js` + `content.js`（已排除 sourcemap） |
| `LinguaBridge-dsh-plugin-0.2.1.zip` | 9.4 KB | `f49e4b3e…bc77` | 插件：`package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`locale/{en,zh}.json`、`icon.svg` |
| 同名 `.json` | — | — | 构建时间、逐文件与整包 SHA-256、安装说明 |

上一版仍保留：`LinguaBridge-extension-0.2.0.zip`、`LinguaBridge-dsh-plugin-0.2.0.zip`（0.2.0 的插件包不含翻译动画）。
首版：`LinguaBridge-0.1.0.zip`（tag `v0.1.0` 指向它，未重命名）。

整包哈希以各自 `.json` 的 `archiveSha256` 为准；重新打包会更新。

## 扩展里有什么

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3 清单：权限、注入范围、快捷键、Service Worker 入口 |
| `background.js` | 唯一向 `127.0.0.1` 发 HTTP 的模块；翻译编排、健康探测、右键菜单、快捷键转发、徽标 |
| `content.js` | 站点适配器（DSH / ChatGPT）、IME 守卫、原文对比面板、译文卡片 |

## 插件里有什么

| 文件 | 作用 |
|------|------|
| `package.json` | 包名 `@local/linguabridge-send`、`dsh.bundle.patch`、`dsh.client`（platform/immediately/inject）、导出与 `files` |
| `cordis.patch.yml` | 向 profile 插入一行插件条目 |
| `index.js` | Host 半边，空的 `apply()`（本插件不需要 Host 服务或工具） |
| `client.js` | 全部逻辑：插槽注册、草稿读取、格式保护、引擎调用、写回与提交 |
| `locale/en.json`、`locale/zh.json` | 插件页显示用的标题与描述 |
| `icon.svg` | 插件图标 |

## 功能

### 扩展（配合浏览器里的 DSH Web UI / ChatGPT）

- `Ctrl+Alt+T` 或「译」按钮：中文草稿 → 原文/译文对比面板（译文可编辑）→「写入输入框」或「写入并发送」
- 结构性格式保护：代码块、行内代码、URL、邮箱、路径、命令、环境变量、`{{模板}}` 不进引擎，逐字还原
- 约束词提示：必须/不得/只输出/仅限/上下限/除非/保持/分步/指定语言/指定格式 + 否定词粗检
- AI 回复译中文：独立可折叠卡片，不改原 DOM
- IME 组合期静默、右键菜单降级通道、工具栏健康徽标、失败不发送

### DSH 插件（装在 DSH 自己的输入区）

- 输入框右侧工具行多一个「译」按钮：**点一次 = 译成英文并直接发送**
- 会话里你自己那条消息即英文，模型收到的也是英文
- 同一套格式保护；失败（引擎不可达/超时/空译文）不发送、保留草稿、错误显示在按钮旁

## 安装

**扩展**：解压 `LinguaBridge-extension-0.2.0.zip` → `edge://extensions` / `chrome://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选 `LinguaBridge-extension-0.2.0`。

**插件**：解压 `LinguaBridge-dsh-plugin-0.2.0.zip`，在 DSH 插件管理器里以 `LinguaBridge-dsh-plugin-0.2.0` 目录安装；安装后刷新页面（`Ctrl+R`），输入框右侧出现「译」。

## 运行依赖

| 依赖 | 要求 |
|------|------|
| 浏览器 | Chrome / Edge 116+（扩展） |
| DSH | 桌面版或 Web 均可（插件）；扩展需在浏览器打开 `dsh web` 的地址 |
| 本地引擎 | 两个产物都**不含**引擎：仓库根目录 `pwsh -File tools\install.ps1`，然后 `pwsh -File tools\start-engine.ps1` |
| 引擎地址 | 默认 `http://127.0.0.1:5000`，仅监听回环；插件可用 localStorage 的 `linguabridge.endpoint` 覆盖 |

## 权限（扩展）

`permissions`：`storage`、`contextMenus`、`activeTab`；`host_permissions` 仅 `127.0.0.1`、`localhost`、`chatgpt.com`、`chat.openai.com`。不申请 `<all_urls>`，由测试断言。

插件不新增网络权限：它在 DSH 渲染进程里直接请求本机引擎。

## 校验与复现

```powershell
Get-FileHash .\LinguaBridge-extension-0.2.0.zip -Algorithm SHA256   # 对比 .json 的 archiveSha256
pwsh -File scripts\package.ps1          # 重新生成扩展包
pwsh -File scripts\package-plugin.ps1   # 重新生成插件包
```

## 不含什么 / 已知限制

- 不含本地引擎与模型（约 164 MB，第三方分发物）；由 `tools\install.ps1` 安装。
- 扩展不含 sourcemap，控制台堆栈是压缩行号。
- 插件只做中 → 英的用户输入；AI 回复译中文仍靠扩展。
- 插件按"方案 A"落地：点的是新增的「译」按钮，不是原生发送键。
- Argos 属传统 NMT，复杂否定与长句可能走样；格式逐字保住，语义需人眼扫一下。
- DSH 桌面版无法加载浏览器扩展；扩展需在浏览器打开 `dsh web` 的地址。
