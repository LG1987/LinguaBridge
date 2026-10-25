/**
 * ChatGPT adapter (secondary target).
 *
 * ChatGPT's composer has been a `<textarea id="prompt-textarea">` and, in newer
 * builds, a ProseMirror `contenteditable` with the same id, so both are handled.
 * Assistant turns are identified by the stable `data-message-author-role`
 * attribute instead of class names.
 */

import {
  isVisible,
  normalizeEditorText,
  pressEnter,
  readEditable,
  writeToEditable,
  type WriteResult,
} from "../dom.ts";
import { elementToText } from "../text.ts";
import type { ResponseTarget, SiteAdapter } from "./types.ts";

const INPUT_SELECTORS = [
  "#prompt-textarea",
  'form [contenteditable="true"]',
  'main [contenteditable="true"]',
  'textarea[placeholder]',
];

const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

function firstVisible(selectors: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (isVisible(element)) return element;
    }
  }
  return null;
}

export class ChatGptAdapter implements SiteAdapter {
  readonly id = "chatgpt";
  readonly label = "ChatGPT";

  private cachedInput: HTMLElement | null = null;

  match(url: URL): boolean {
    return url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com";
  }

  getInputElement(): HTMLElement | null {
    if (this.cachedInput !== null && this.cachedInput.isConnected && isVisible(this.cachedInput)) {
      return this.cachedInput;
    }
    this.cachedInput = firstVisible(INPUT_SELECTORS);
    return this.cachedInput;
  }

  readInput(): string {
    const input = this.getInputElement();
    return input === null ? "" : normalizeEditorText(readEditable(input));
  }

  writeInput(text: string): WriteResult {
    const input = this.getInputElement();
    if (input === null) {
      return { ok: false, method: "none", actual: "", reason: "找不到 ChatGPT 输入框，请先点一下输入框再试。" };
    }
    return writeToEditable(input, text);
  }

  send(): boolean {
    const button =
      document.querySelector<HTMLElement>('[data-testid="send-button"]') ??
      document.querySelector<HTMLElement>('button[aria-label*="Send" i]') ??
      document.querySelector<HTMLElement>('button[aria-label*="发送"]');
    if (button !== null && !button.hasAttribute("disabled")) {
      button.click();
      return true;
    }
    const input = this.getInputElement();
    if (input !== null) {
      pressEnter(input);
      return true;
    }
    return false;
  }

  getLatestResponse(): ResponseTarget | null {
    const nodes = [...document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR)].filter(isVisible);
    const last = nodes[nodes.length - 1];
    if (last === undefined) return null;

    const text = elementToText(last);
    if (text.length < 8) return null;

    const key = last.getAttribute("data-message-id") ?? `hash:${text.length}:${text.slice(0, 64)}`;
    return { key, text, anchor: last };
  }

  insertResponseCard(target: ResponseTarget, card: HTMLElement): void {
    const anchor = target.anchor.isConnected ? target.anchor : null;
    if (anchor === null) return;
    // Prefer inserting after the whole `<article>` turn when present.
    const article = anchor.closest("article");
    (article ?? anchor).insertAdjacentElement("afterend", card);
  }

  observeResponses(callback: () => void): () => void {
    const root = document.querySelector("main") ?? document.body;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(callback, 900);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      observer.disconnect();
    };
  }
}
