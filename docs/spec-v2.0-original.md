# LinguaBridge：DSH 优先 + ChatGPT 适配的完全本地翻译方案

> 版本：v2.0（优化整合版）  
> 日期：2026-10-25  
> 目标：为浏览器扩展提供**完全本地、零付费 API** 的翻译能力，优先适配 **DeepSeek Harness（DSH）AI Agent**，其次适配 **ChatGPT**，并覆盖 Windows 11 本地运行全流程。  
> 核心技术路线：Chrome / Edge 扩展（Manifest V3）+ TypeScript + LibreTranslate（Argos）本地服务 + 可选本地小尺寸翻译 LLM。

---

## 0. 方案结论（优化后）

### 推荐架构

```
用户在 DSH Web UI / ChatGPT 输入中文
          │
          ▼
浏览器扩展 Content Script（站点适配器）
          │
          ▼
扩展 Background Service Worker
          │  HTTP 请求（仅本机）
          ▼
本机 LibreTranslate（127.0.0.1:5000）
          │
          ▼
Argos Translate + 已安装语言模型
（可选：本地小尺寸翻译 LLM 作为高质量 Provider）
          │
          ▼
返回英文译文 → 扩展展示「原文 vs 译文」→ 用户确认后写入输入框并发送
```

**回复翻译**：提取 AI 回复文本 → 本地翻译为阅读语言（默认中文）→ 在页面旁插入独立译文区域，**不覆盖原 DOM**。

### 为什么先做 DSH

- DSH 是 DeepSeek 官方开源的 Agent Harness（`npx @deepseek-ai/dsh web`），本地运行于 `http://127.0.0.1:3080`，隐私边界清晰。
- 输入框为 `contenteditable`（Lexical 编辑器），有明确 DOM 锚点与社区插件生态，适配成本可控。
- 用户群体高度重合：中文开发者使用 Agent 写代码/执行任务时，需要高质量中英提示词翻译。
- 与「完全本地」理念高度一致。

### 必须接受的限制（已优化认知）

- Argos 属于传统 NMT，对复杂约束词、否定、技术术语、长提示词质量有限 → **必须强制手动确认 + 原文对比**。
- 中文简繁混杂问题存在 → **必须加 OpenCC 后处理**。
- DSH 输入框对中文 IME 有已知问题 → 适配器必须正确处理 composition 事件。
- 网站 DOM 会变化 → 适配器需用稳定 data 属性 + 降级策略。

---

## 1. Windows 11 本地翻译服务安装（通用基础）

### 1.1 环境准备

```powershell
# 检查 Python
python --version
py --version

# 建议使用 Python 3.11
# 下载：https://www.python.org/downloads/windows/
```

### 1.2 一键创建虚拟环境与安装

```powershell
mkdir C:\LinguaBridge
cd C:\LinguaBridge

py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1

python -m pip install --upgrade pip
python -m pip install libretranslate
```

### 1.3 启动服务（只加载中英）

```powershell
libretranslate --host 127.0.0.1 --port 5000 --load-only en,zh,zt
```

- 首次启动会自动下载模型（约 4 个包，每个 ~70MB）。
- 保持终端运行。建议后续做成系统托盘辅助程序。

### 1.4 验证

另开 PowerShell：

```powershell
$body = @{
  q      = "请帮我解释 TypeScript 中的泛型，并给出示例代码。"
  source = "zh"
  target = "en"
  format = "text"
}

Invoke-RestMethod `
  -Uri "http://127.0.0.1:5000/translate" `
  -Method Post `
  -ContentType "application/x-www-form-urlencoded" `
  -Body $body
```

检查 `/languages`：`http://127.0.0.1:5000/languages`

### 1.5 推荐增强（质量与运维）

| 项目 | 建议 |
|------|------|
| 简繁处理 | 翻译后用 OpenCC 做 `s2t` / `t2s` |
| 术语保护 | 维护用户 glossary，翻译前占位、翻译后还原 |
| 健康检查 | 扩展启动时探测 `127.0.0.1:5000`，失败给出一键引导 |
| 桌面辅助 | 用 Tauri / Electron / Go 做托盘程序，管理启动/停止/模型下载 |
| 高质量可选 | 后续增加本地小尺寸翻译 LLM（Hy-MT2 1.8B 等）作为第二 Provider |

---

## 2. 浏览器扩展核心架构

### 2.1 Manifest V3 最小配置

```json
{
  "manifest_version": 3,
  "name": "LinguaBridge",
  "version": "0.2.0",
  "permissions": ["storage", "activeTab"],
  "host_permissions": [
    "http://127.0.0.1:5000/*",
    "http://127.0.0.1:3080/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": [
        "http://127.0.0.1:3080/*",
        "https://chatgpt.com/*",
        "https://chat.openai.com/*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
```

**原则**：只申请实际需要的 host，不默认读取所有网站。

### 2.2 统一 TranslationProvider 接口

```ts
export type TranslationRequest = {
  text: string;
  sourceLanguage: string | "auto";
  targetLanguage: string;
  mode: "prompt" | "response" | "plain";
  chineseVariant?: "simplified" | "traditional" | "auto";
};

export type TranslationResult = {
  translatedText: string;
  providerId: string;
  latencyMs: number;
  warnings?: string[];   // 约束词可能被改写等
};

export interface TranslationProvider {
  readonly id: string;
  translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult>;
}
```

默认实现：`LibreTranslateProvider`（支持 JSON 或 form，带超时、空结果检测）。

后续可插拔：`LocalLlmTranslatorProvider`。

### 2.3 默认设置

```ts
export const defaultSettings = {
  provider: "libretranslate-local",
  localEndpoint: "http://127.0.0.1:5000",
  sendTargetLanguage: "en",
  readingLanguage: "zh",
  chineseVariant: "simplified",
  inputMode: "manual",          // 强制手动确认
  responseMode: "bilingual",    // 原文 + 译文
  preserveCode: true,
  preserveMarkdown: true,
  saveHistory: false,
  timeoutMs: 15000
};
```

---

## 3. 提示词格式保护（必须实现）

流程：

1. 用 Markdown 解析器识别 fenced code block 与 inline code。
2. 保护 URL、邮箱、文件路径、常见命令。
3. 替换为唯一占位符（如 `⟦CODE_001⟧`）。
4. 只翻译自然语言部分。
5. 还原占位符并校验完整性。
6. 校验失败 → 提示用户，**绝不自动发送**。
7. 翻译后扫描约束词（必须 / 不得 / must / do not / only output 等），异常时警告。

代码块整体保留，不交给 NMT。

---

## 4. DSH（DeepSeek Harness）适配器（优先实现）

### 4.1 DSH 运行方式

```bash
# 需要 Node.js ≥ 22
npx -y @deepseek-ai/dsh web
# 浏览器打开 http://127.0.0.1:3080
```

- 本地 Web UI，隐私友好。
- 输入框是 `contenteditable`（Lexical 编辑器），**不是 textarea**。
- 已知问题：中文 IME 组合期间若触发 React 重渲染，会导致拼音碎片。

### 4.2 稳定 DOM 锚点（社区验证）

优先使用：

- `[data-composer-seat]` / `[data-composer-card]`
- 输入表面：`div[contenteditable="true"]`（可能带动态 class）
- 会话滚动容器：`[data-conversation-scroll]`
- 消息锚点：`[data-chat-anchor-key]`

**不要**依赖易变的 CSS class 名（如 `uV2eY6_input`）。

### 4.3 SiteAdapter 接口（DSH 实现要点）

```ts
interface SiteAdapter {
  id: "dsh";
  match(url: string): boolean;                    // 127.0.0.1:3080
  getInputElement(): HTMLElement | null;          // contenteditable
  getSendTrigger(): () => void;                   // 模拟发送或找发送按钮
  extractLatestResponseText(): string | null;
  insertTranslatedResponse(text: string): void;   // 旁路插入，不覆盖
  isComposing(): boolean;                         // IME 状态
}
```

### 4.4 关键实现细节

1. **读取输入**  
   从 contenteditable 取 `textContent` 或 Lexical 序列化结果。注意空行与 chip。

2. **写入译文**  
   - 优先通过 DSH 公开的 input actions / 事件通道（如果可注入）。  
   - 降级：清空后设置 textContent，并派发 `input` 事件。  
   - **必须**在 `compositionstart` ~ `compositionend` 期间不做任何写入。

3. **IME 保护**  
   监听 composition 事件，组合期间禁止自动翻译触发与 DOM 修改。

4. **发送**  
   用户确认后写入输入框，再模拟 Enter 或点击发送按钮。Shift+Enter 换行不触发发送。

5. **回复翻译**  
   监听会话区新消息出现（MutationObserver + data 属性），提取完整回答后翻译，插入独立译文卡片（可折叠）。

6. **降级策略**  
   若适配器失效，回退到「用户选中文本 → 右键菜单翻译」通用模式。

### 4.5 DSH 特有验收

- [ ] 中文拼音输入法组合期间不会误触发翻译或破坏输入
- [ ] contenteditable 写入后，DSH 状态机仍能正确识别草稿
- [ ] 代码块与路径在提示词中完整保留
- [ ] 回复译文不破坏原有代码复制、折叠、工具调用展示
- [ ] 本地服务不可达时给出明确引导

---

## 5. ChatGPT 适配器（Windows 11 本地）

### 5.1 目标站点

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`（兼容旧域名）

### 5.2 输入与发送定位策略

ChatGPT 输入框长期是 `textarea` 或 contenteditable，会随版本变化。推荐策略：

1. 优先查找带 `data-testid` 或稳定 role 的元素（如 `prompt-textarea`）。
2. 回退到可见的 textarea / contenteditable。
3. 发送按钮通常在输入区附近，可用文本「发送」或 aria-label 定位。
4. 使用 `MutationObserver` 监听输入区出现，适配 SPA 路由切换。

### 5.3 写入与确认流程

1. 用户输入中文 → 扩展检测（或手动触发）。
2. 调用本地翻译 → 展示「原文 vs 译文」对比面板（可编辑译文）。
3. 用户确认 → 写入输入框 → 可选自动点击发送或让用户自己发。
4. **失败 / 超时 / 占位符校验失败** → 保留原文，明确提示，绝不静默发送。

### 5.4 回复翻译

- 等待回答完成（或用户手动点击「翻译此回复」）。
- 提取最后一条助手消息文本。
- 本地翻译为中文后，在消息下方插入独立译文区域（支持折叠 / 复制）。
- 不覆盖原 DOM，保证代码块复制、引用功能正常。

### 5.5 Windows 11 特别注意

- 中文输入法（微软拼音 / 搜狗）组合期间禁止触发。
- Shift+Enter 换行 vs Enter 发送的逻辑必须与网站一致。
- 扩展禁用后，ChatGPT 原有输入与发送必须完全正常。
- 本地服务绑定 `127.0.0.1`，避免被局域网访问。

### 5.6 ChatGPT 验收清单

- [ ] 中文 → 英文提示词翻译成功，用户确认后可发送
- [ ] 代码块、URL、行内代码不被破坏
- [ ] 输入法组合期间不误触发
- [ ] 翻译失败不自动发送
- [ ] 回复可双语展示，原文可完整复制
- [ ] 插件禁用后网站功能无影响

---

## 6. 通用质量与安全门禁（两站共用）

| 门禁 | 要求 |
|------|------|
| 输入模式 | 默认 `manual`，必须展示原文对比 |
| 超时 | 短文本 8s，长文本 15–20s，可配置 |
| 失败策略 | 保留原文 + 明确错误原因，禁止自动发送 |
| 格式保护 | 代码块 / URL / 路径 100% 还原，否则拒绝 |
| 约束词检测 | 翻译后扫描，异常时警告 |
| 简繁 | OpenCC 后处理，用户可设简/繁偏好 |
| 日志 | 不记录完整提示词与回复正文 |
| 权限 | 最小 host_permissions，Background 统一请求 |
| 服务绑定 | 仅 `127.0.0.1` |

---

## 7. MVP 开发阶段（调整后）

| 阶段 | 任务 | 验收结果 |
|------|------|----------|
| P0 | Windows 11 安装 LibreTranslate + 中英模型 + 健康检查脚本 | PowerShell 可完成中英互译 |
| P1 | TypeScript Provider + 格式保护 + 手动确认 UI | 扩展可请求本机服务并展示对比 |
| **P2** | **完成 DSH 适配器** | 用户能在 DSH Web UI 翻译提示词并确认发送 |
| P3 | DSH 回复翻译 + IME 保护 | 回复可双语展示，输入法无干扰 |
| P4 | 完成 ChatGPT 适配器 | ChatGPT 同样流程可用 |
| P5 | ChatGPT 回复翻译 + 两站回归测试 | 格式保护、失败不发送、禁用无影响 |
| P6 | 简繁 OpenCC + 术语表 + 可选本地 LLM Provider | 质量明显提升 |
| P7 | 桌面辅助程序（托盘启动服务） | 普通用户可一键启动本地引擎 |

---

## 8. 最终产品原则

1. **语言辅助层，而非绕过工具**。  
2. **本地优先、隐私优先、失败不发送**。  
3. **DSH 先跑通，再扩 ChatGPT 和其他站点**。  
4. **Argos 只是起步，质量门禁与可替换 Provider 必须从第一天就设计好**。  
5. **把格式保护、手动确认、IME 安全做成不可妥协的底线**。

---

## 9. 立即可执行的下一步

1. 在 Windows 11 上按第 1 节启动 LibreTranslate 并验证中英。
2. 建立 30–50 条真实 AI 提示词测试集（含代码、约束词、否定）。
3. 实现 `LibreTranslateProvider` + 基础格式保护 + 原文对比预览。
4. 实现 **DSH SiteAdapter**（优先），重点处理 contenteditable 与 IME。
5. 通过 DSH 验收后再做 ChatGPT 适配器。
6. 补充一键健康检查脚本与扩展内服务不可达引导。

完成以上后，再考虑多站点扩展与本地 LLM 升级，成功率和用户体验会显著更高。

---

**文档结束**
