/**
 * Confirmation UI.
 *
 * Rendered into a shadow root so site CSS (and DSH's own CSS reset) cannot
 * restyle it, and so the page's keyboard handlers never see the panel's keys.
 * The panel never sends anything by itself: every write is a click.
 */

export interface PanelView {
  source: string;
  translation: string;
  warnings: string[];
  /** e.g. `libretranslate-local · 1.4s · 已还原 3 处格式`. */
  meta?: string;
  error?: string;
  busy?: boolean;
}

export interface PanelHandlers {
  onRetranslate: () => void;
  onWrite: (text: string) => void;
  onWriteAndSend: (text: string) => void;
  onClose: () => void;
}

const BASE_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .panel {
    font: 13px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
    color: #1f2328;
    background: #ffffff;
    border: 1px solid rgba(15, 23, 42, 0.12);
    border-radius: 14px;
    box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22), 0 2px 6px rgba(15, 23, 42, 0.08);
    display: flex;
    flex-direction: column;
    width: min(620px, calc(100vw - 32px));
    max-height: min(62vh, 560px);
    overflow: hidden;
  }
  .header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px 8px; border-bottom: 1px solid rgba(15, 23, 42, 0.08);
    background: linear-gradient(180deg, rgba(99, 102, 241, 0.08), transparent);
  }
  .title { font-weight: 600; font-size: 13px; letter-spacing: 0.01em; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #6366f1; }
  .meta { color: #667085; font-size: 11.5px; margin-left: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .icon-button {
    border: 0; background: transparent; cursor: pointer; color: #667085;
    font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 8px;
  }
  .icon-button:hover { background: rgba(15, 23, 42, 0.06); color: #1f2328; }
  .body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow: auto; }
  .block { display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .label { font-size: 11px; font-weight: 600; color: #667085; letter-spacing: 0.04em; text-transform: uppercase; }
  .source {
    margin: 0; padding: 8px 10px; border-radius: 9px;
    background: rgba(15, 23, 42, 0.04); border: 1px solid rgba(15, 23, 42, 0.06);
    white-space: pre-wrap; word-break: break-word; max-height: 17vh; overflow: auto;
    font-family: inherit; user-select: text;
  }
  textarea.translation {
    width: 100%; min-height: 104px; resize: vertical; padding: 8px 10px;
    border-radius: 9px; border: 1px solid rgba(15, 23, 42, 0.16);
    font: inherit; line-height: 1.5; background: #fff; color: inherit;
    outline: none;
  }
  textarea.translation:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.16); }
  .status { font-size: 12px; color: #667085; min-height: 16px; }
  .status.error { color: #b42318; }
  .status.ok { color: #067647; }
  .warnings {
    border: 1px solid rgba(180, 83, 9, 0.28); background: rgba(254, 240, 199, 0.55);
    border-radius: 9px; padding: 7px 10px; color: #7a4b06; font-size: 12px;
  }
  .warnings summary { cursor: pointer; font-weight: 600; }
  .warnings ul { margin: 6px 0 0; padding-left: 18px; }
  .warnings li { margin: 2px 0; }
  .footer {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 10px 12px; border-top: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(15, 23, 42, 0.02);
  }
  button.action {
    font: inherit; font-size: 12.5px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(15, 23, 42, 0.16); background: #fff; color: #1f2328;
  }
  button.action:hover:not(:disabled) { background: rgba(15, 23, 42, 0.05); }
  button.action:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; font-weight: 600; }
  button.primary:hover:not(:disabled) { background: #4338ca; }
  button.send { background: #0f766e; border-color: #0f766e; color: #fff; }
  button.send:hover:not(:disabled) { background: #115e59; }
  .hint { font-size: 11px; color: #98a2b3; margin-left: auto; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #16181d; color: #e6e6e6; border-color: rgba(255,255,255,0.12); }
    .header { border-bottom-color: rgba(255,255,255,0.08); background: linear-gradient(180deg, rgba(99,102,241,0.18), transparent); }
    .meta, .label, .status { color: #9aa4b2; }
    .source { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.08); }
    textarea.translation { background: #101216; border-color: rgba(255,255,255,0.16); color: #e6e6e6; }
    button.action { background: #1d2027; border-color: rgba(255,255,255,0.16); color: #e6e6e6; }
    button.action:hover:not(:disabled) { background: #242832; }
    button.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
    button.send { background: #0f766e; border-color: #0f766e; color: #fff; }
    .warnings { background: rgba(120, 72, 12, 0.35); border-color: rgba(217, 119, 6, 0.45); color: #f4c97a; }
    .footer { background: rgba(255,255,255,0.03); border-top-color: rgba(255,255,255,0.08); }
  }
`;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class ComparePanel {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private handlers: PanelHandlers;
  private sourceEl: HTMLPreElement | null = null;
  private translationEl: HTMLTextAreaElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private warningsEl: HTMLDetailsElement | null = null;
  private warningsList: HTMLUListElement | null = null;
  private metaEl: HTMLSpanElement | null = null;
  private buttons: HTMLButtonElement[] = [];
  private writeButton: HTMLButtonElement | null = null;
  private sendButton: HTMLButtonElement | null = null;

  constructor(handlers: PanelHandlers) {
    this.handlers = handlers;
  }

  get isOpen(): boolean {
    return this.host !== null && this.host.isConnected;
  }

  getTranslation(): string {
    return this.translationEl?.value ?? "";
  }

  open(): void {
    if (this.host !== null) {
      this.host.style.display = "block";
      return;
    }
    const host = document.createElement("div");
    host.dataset["linguabridge"] = "panel";
    host.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:132px;z-index:2147483000;display:block;";
    // Keep the page from reacting to the panel's own keys and clicks.
    for (const type of ["keydown", "keyup", "keypress", "pointerdown", "mousedown", "click"]) {
      host.addEventListener(type, (event) => event.stopPropagation());
    }

    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = BASE_CSS;

    const panel = node("div", "panel");

    const header = node("div", "header");
    header.append(node("span", "dot"), node("span", "title", "LinguaBridge"));
    const meta = node("span", "meta", "");
    meta.setAttribute("aria-live", "polite");
    header.append(meta, node("span", "spacer"));
    const close = node("button", "icon-button", "×");
    close.title = "关闭（Esc）";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => this.handlers.onClose());
    header.append(close);

    const body = node("div", "body");
    const sourceBlock = node("div", "block");
    sourceBlock.append(node("div", "label", "原文"));
    const source = node("pre", "source");
    sourceBlock.append(source);

    const translationBlock = node("div", "block");
    translationBlock.append(node("div", "label", "译文（可编辑）"));
    const translation = node("textarea", "translation");
    translation.spellcheck = false;
    translation.setAttribute("aria-label", "译文");
    // Enter must stay a newline inside the panel, never a page-level send.
    translation.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) event.stopPropagation();
    });
    translationBlock.append(translation);

    const status = node("div", "status");
    status.setAttribute("role", "status");

    const warnings = document.createElement("details");
    warnings.className = "warnings";
    const summary = document.createElement("summary");
    warnings.append(summary);
    const warningList = node("ul");
    warnings.append(warningList);
    warnings.style.display = "none";

    body.append(sourceBlock, translationBlock, warnings, status);

    const footer = node("div", "footer");
    const copy = node("button", "action", "复制译文");
    copy.addEventListener("click", () => {
      void this.copyTranslation();
    });
    const retry = node("button", "action", "重译");
    retry.addEventListener("click", () => this.handlers.onRetranslate());
    const write = node("button", "action primary", "写入输入框");
    write.addEventListener("click", () => this.handlers.onWrite(this.getTranslation()));
    const writeAndSend = node("button", "action send", "写入并发送");
    writeAndSend.addEventListener("click", () => this.handlers.onWriteAndSend(this.getTranslation()));
    const hint = node("span", "hint", "Esc 关闭 · 写入前请核对");
    footer.append(copy, retry, write, writeAndSend, hint);

    panel.append(header, body, footer);
    root.append(style, panel);
    document.documentElement.append(host);

    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.handlers.onClose();
      }
    });

    this.host = host;
    this.root = root;
    this.sourceEl = source;
    this.translationEl = translation;
    this.statusEl = status;
    this.warningsEl = warnings;
    this.warningsList = warningList;
    this.metaEl = meta;
    this.buttons = [copy, retry, write, writeAndSend];
    this.writeButton = write;
    this.sendButton = writeAndSend;
  }

  render(view: PanelView): void {
    this.open();
    if (this.sourceEl !== null) this.sourceEl.textContent = view.source;
    if (this.translationEl !== null && this.translationEl.value !== view.translation) {
      this.translationEl.value = view.translation;
    }
    if (this.metaEl !== null) this.metaEl.textContent = view.meta ?? "";

    if (this.warningsEl !== null && this.warningsList !== null) {
      this.warningsList.replaceChildren();
      for (const warning of view.warnings) {
        this.warningsList.append(node("li", undefined, warning));
      }
      const visible = view.warnings.length > 0;
      this.warningsEl.style.display = visible ? "block" : "none";
      this.warningsEl.open = visible;
      const summary = this.warningsEl.querySelector("summary");
      if (summary !== null) summary.textContent = `注意事项（${view.warnings.length}）— 建议逐句核对`;
    }

    const busy = view.busy === true;
    for (const button of this.buttons) button.disabled = busy;
    if (this.writeButton !== null) this.writeButton.disabled = busy || view.translation.trim() === "";
    if (this.sendButton !== null) this.sendButton.disabled = busy || view.translation.trim() === "";

    this.setStatus(view.error ?? (busy ? "正在请求本地翻译…" : ""), view.error !== undefined ? "error" : "info");
  }

  setStatus(message: string, kind: "info" | "error" | "ok" = "info"): void {
    if (this.statusEl === null) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `status ${kind === "info" ? "" : kind}`.trim();
  }

  /** Called by the controller after a write attempt, so the panel stays honest. */
  setOutcome(message: string, kind: "ok" | "error"): void {
    this.setStatus(message, kind);
  }

  close(): void {
    if (this.host !== null) {
      this.host.remove();
      this.host = null;
      this.root = null;
      this.sourceEl = null;
      this.translationEl = null;
      this.statusEl = null;
      this.warningsEl = null;
      this.warningsList = null;
      this.metaEl = null;
      this.buttons = [];
      this.writeButton = null;
      this.sendButton = null;
    }
  }

  private async copyTranslation(): Promise<void> {
    const text = this.getTranslation();
    if (text === "") return;
    try {
      await navigator.clipboard.writeText(text);
      this.setStatus("译文已复制。", "ok");
    } catch {
      // Clipboard can be blocked; fall back to a temporary textarea.
      const scratch = document.createElement("textarea");
      scratch.value = text;
      document.body.append(scratch);
      scratch.select();
      try {
        document.execCommand("copy");
        this.setStatus("译文已复制。", "ok");
      } catch {
        this.setStatus("复制失败，请手动选中译文。", "error");
      } finally {
        scratch.remove();
      }
    }
  }
}

/** Small floating launcher so the feature is discoverable without a shortcut. */
export function createLauncher(onClick: () => void): HTMLElement {
  const host = document.createElement("div");
  host.dataset["linguabridge"] = "launcher";
  host.style.cssText = "position:fixed;right:18px;bottom:88px;z-index:2147483000;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    button {
      font: 600 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      width: 38px; height: 38px; border-radius: 50%; cursor: pointer;
      border: 1px solid rgba(15, 23, 42, 0.12);
      background: #ffffff; color: #4f46e5;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.18);
      display: grid; place-items: center;
    }
    button:hover { background: #eef2ff; }
    @media (prefers-color-scheme: dark) {
      button { background: #1d2027; color: #a5b4fc; border-color: rgba(255,255,255,0.16); }
      button:hover { background: #262b36; }
    }
  `;
  const button = document.createElement("button");
  button.textContent = "译";
  button.title = "LinguaBridge：翻译输入框（Ctrl+Alt+T）";
  button.setAttribute("aria-label", "翻译输入框");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  root.append(style, button);
  return host;
}

/**
 * Bilingual reply card inserted after an assistant message. Collapsible and
 * copyable; it never replaces the original message, so code blocks and links
 * keep working.
 */
export function createReplyCard(options: {
  translatedText: string;
  meta: string;
  warnings: string[];
}): HTMLElement {
  const host = document.createElement("div");
  host.dataset["linguabridge"] = "reply";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .card {
      font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1f2328; background: rgba(99, 102, 241, 0.06);
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-left: 3px solid #6366f1;
      border-radius: 10px; margin: 10px 0; padding: 8px 12px;
    }
    .head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #5b5fc7; font-weight: 600; }
    .spacer { flex: 1; }
    .text { margin-top: 6px; white-space: pre-wrap; word-break: break-word; user-select: text; }
    .text.collapsed { display: none; }
    button { font: inherit; font-size: 11.5px; border: 0; background: transparent; color: #5b5fc7; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
    button:hover { background: rgba(99, 102, 241, 0.12); }
    .warn { margin-top: 6px; font-size: 11.5px; color: #92400e; }
    @media (prefers-color-scheme: dark) {
      .card { background: rgba(99, 102, 241, 0.12); border-color: rgba(129, 140, 248, 0.35); color: #e6e6e6; }
      .head, button { color: #a5b4fc; }
      .warn { color: #fbbf24; }
    }
  `;
  const card = document.createElement("div");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "head";
  head.append(document.createTextNode("本地译文"));
  const meta = document.createElement("span");
  meta.textContent = ` · ${options.meta}`;
  meta.style.fontWeight = "400";
  head.append(meta, document.createElement("span"));
  head.lastElementChild?.setAttribute("class", "spacer");

  const collapse = document.createElement("button");
  collapse.textContent = "收起";
  const copy = document.createElement("button");
  copy.textContent = "复制";

  const text = document.createElement("div");
  text.className = "text";
  text.textContent = options.translatedText;

  collapse.addEventListener("click", () => {
    const collapsed = text.classList.toggle("collapsed");
    collapse.textContent = collapsed ? "展开" : "收起";
  });
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(options.translatedText).catch(() => {});
    copy.textContent = "已复制";
    setTimeout(() => {
      copy.textContent = "复制";
    }, 1200);
  });

  head.append(collapse, copy);
  card.append(head, text);
  if (options.warnings.length > 0) {
    const warn = document.createElement("div");
    warn.className = "warn";
    warn.textContent = `⚠ ${options.warnings.length} 条注意事项（可能影响语义，请对照原文）`;
    card.append(warn);
  }
  root.append(style, card);
  return host;
}
