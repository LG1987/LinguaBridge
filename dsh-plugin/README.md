# DSH 原生插件：译并发送

`linguabridge-send/` 是一个 **DSH 客户端插件包**（Cordis bundle），把"译并发送"做进 DSH 自己的输入区，不依赖浏览器扩展。

## 行为

1. 输入框里写中文；
2. 点输入区工具行里的 **「译」** 按钮（发送键左侧）；
3. 插件调用本机引擎 `127.0.0.1:5000` 把草稿译成英文，写回草稿并**直接提交**；
4. 会话里你自己那条消息即英文，模型收到的也是英文。

失败时不发送：草稿保留，错误显示在按钮右侧（空输入框、引擎不可达、超时、空译文）。

点击后立即显示加载动画（`release/动画.txt` 里的 `.loading-326` 效果，已改名为 `lb-loader`）：两张黄色方块在模糊/对比滤镜下粘合循环位移，翻译结束即消失。动画放在 `position: fixed` 的悬浮条里，位于输入框上方，不参与 composer 布局；外层白色容器用于隔离 `mix-blend-mode: darken`，避免深色主题下变黑。

## 格式保护

与扩展版同一套规则：代码块、行内代码、URL、邮箱、Windows/相对路径、常见命令、环境变量、`{{模板}}` 不送进引擎，直接拼回；因此代码缩进与路径逐字保留。这是结构性的——引擎看不到这些片段，就不可能改坏它们。

## 安装 / 卸载

安装通过 DSH 的插件管理器完成（会写入当前 profile，对所有会话生效）：

- 安装：`plugin_manager` 的 `install_bundle`，target 为本目录的绝对路径；
- 停用/卸载：插件页或 `plugin_manager` 的 `set_bundle` / `remove_bundle`。

## 实现说明

- 只注册一个插槽条目：`conversation.input.right`（id `linguabridge-send`，order 20）。
- 读写草稿走插槽标准属性 `useInput` 与 `inputActions`（`setDraft` → 等待一帧 → `submit`）。
- 引擎地址可用 localStorage 的 `linguabridge.endpoint` 覆盖，默认 `http://127.0.0.1:5000`。
- Host 半边是空的（`index.js` 仅 `export function apply() {}`）：不需要 Host 服务或工具。

## 已知限制 / 待验证

- **草稿字段**：`InputState.draft`（composer 自身即为 `input?.draft ?? ""`），另有 `clipboardText` / `text` / `value` / `projection.*` 作为跨版本兜底。已由 `test/dsh-plugin.local.ts` 用真实 `client.js` 验证。
- **未验证渲染**：安装后只确认了插槽占用（`active: true`）与逻辑测试；按钮的实际外观需要在页面里看。
- **可能的 CSP 限制**：渲染进程直接 `fetch` 到 `127.0.0.1:5000`。若页面 CSP 禁止跨源连接，会报"连不上本地引擎"，届时需要改成 Host 侧代理。
- **翻译质量**：Argos 属传统 NMT，长句与否定可能走样（实测「不要改写实现」会译成 "not rewritten to be achieved"）。格式是逐字保住的，语义需人工扫一眼。
- 仅支持中 → 英；回复翻译仍由扩展或后续版本提供。

## 测试

```powershell
node test\dsh-plugin.local.ts     # 用真实 client.js + 真实引擎跑通"点击→翻译→写回→提交"
```

三个用例：正常链路（含代码块逐字还原）、引擎不可达不发送、空草稿不发送。
