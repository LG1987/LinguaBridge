/**
 * DeepSeek Harness (DSH) adapter — the primary target.
 *
 * Anchors verified against the installed DSH bundle (`app.asar`) rather than
 * assumed:
 *   `[data-composer-seat]`, `[data-composer-card]`     composer containers
 *   `[data-lexical-editor="true"]`                     Lexical editable root
 *   `[data-conversation-scroll]`                       transcript scrollport
 *   `[data-chat-anchor-key]` / `[data-chat-node-key]`  transcript rows
 *   `[data-chat-flow-kind]`, `[data-chat-turn]`        row kind / turn number
 *   `[data-turn-tail]`                                 token-usage / action row
 *   `[data-slot="conversation.chat.user.content"]`     user message body
 *   `[data-slot^="conversation.chat.reasoning"]`       model thinking
 *   `[data-slot^="conversation.trajectory"]`           execution trace
 *   `[data-chat-call-id]`                              tool-call cards
 *   `[data-submission-echo]`                           echoed submission row
 *
 * DSH picks its port at launch (this install serves 52252, not 3080), so
 * `match()` looks for these markers instead of a fixed host or port.
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
  '[data-composer-seat] [data-lexical-editor="true"]',
  '[data-composer-card] [data-lexical-editor="true"]',
  '[data-composer-seat] [contenteditable="true"]',
  '[data-lexical-editor="true"]',
  '[data-composer-seat] textarea',
];

const SCROLL_SELECTORS = ["[data-conversation-scroll]", "[data-chat-anchor-key]"];

const SEND_LABELS = ["send", "发送", "提交", "submit"];

/** Rows that are not assistant prose: the user's own message and metadata rows. */
const NON_ASSISTANT_ROW_SELECTORS = [
  '[data-slot="conversation.chat.user.content"]',
  "[data-submission-echo]",
  "[data-turn-tail]",
  '[data-chat-flow-kind="turn-tail"]',
  "[data-goal-bar]",
  "[data-terminal]",
];

/** Positive signal that a row renders assistant markdown prose. */
const PROSE_SELECTORS = '[class*="_markdown"], [data-markdown-variant], pre, blockquote, table';

/** Subtrees to leave out of the extracted reply text. */
const EXCLUDED_SUBTREES = [
  "button",
  '[role="toolbar"]',
  "[data-chat-call-id]",
  '[data-slot^="conversation.chat.reasoning"]',
  '[data-slot^="conversation.trajectory"]',
  '[data-slot="conversation.chat.assistant-actions"]',
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  "[data-linguabridge]",
].join(", ");

function firstVisible(selectors: readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (isVisible(element)) return element;
    }
  }
  return null;
}

function findSendButton(composer: HTMLElement | null): HTMLElement | null {
  const scope: ParentNode = composer?.closest("[data-composer-card]") ?? document;
  const submit = scope.querySelector<HTMLElement>('button[type="submit"]');
  if (submit !== null && !submit.hasAttribute("disabled")) return submit;

  for (const button of scope.querySelectorAll<HTMLElement>("button")) {
    const label = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${
      button.textContent ?? ""
    }`.toLowerCase();
    if (SEND_LABELS.some((candidate) => label.includes(candidate)) && !button.hasAttribute("disabled")) {
      return button;
    }
  }
  return null;
}

export class DshAdapter implements SiteAdapter {
  readonly id = "dsh";
  readonly label = "DeepSeek Harness";

  private cachedInput: HTMLElement | null = null;

  match(_url: URL): boolean {
    // Marker-based detection: works on any loopback port and on future hosts.
    return (
      document.querySelector("[data-composer-seat]") !== null ||
      document.querySelector('[data-lexical-editor="true"]') !== null ||
      document.querySelector("[data-conversation-scroll]") !== null
    );
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
    if (input === null) return "";
    return normalizeEditorText(readEditable(input));
  }

  writeInput(text: string): WriteResult {
    const input = this.getInputElement();
    if (input === null) {
      return { ok: false, method: "none", actual: "", reason: "找不到 DSH 输入框，请先点一下输入框再试。" };
    }
    return writeToEditable(input, text);
  }

  send(): boolean {
    const input = this.getInputElement();
    const button = findSendButton(input);
    if (button !== null) {
      button.click();
      return true;
    }
    if (input !== null) {
      // Mirror the site's own behaviour: plain Enter sends, Shift+Enter wraps.
      pressEnter(input);
      return true;
    }
    return false;
  }

  /** Transcript rows, newest last, with non-assistant rows already removed. */
  private assistantRows(): HTMLElement[] {
    const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTORS[0] ?? "") ?? document.body;
    const input = this.getInputElement();

    return [...scroller.querySelectorAll<HTMLElement>("[data-chat-anchor-key]")].filter((row) => {
      if (!isVisible(row)) return false;
      if (input !== null && row.contains(input)) return false;
      if (row.closest("[data-composer-seat]") !== null) return false;
      for (const selector of NON_ASSISTANT_ROW_SELECTORS) {
        if (row.querySelector(selector) !== null) return false;
      }
      return true;
    });
  }

  getLatestResponse(): ResponseTarget | null {
    const rows = this.assistantRows();
    const candidates: Array<{ row: HTMLElement; text: string; prose: boolean }> = [];

    for (const row of rows) {
      const text = this.extractRowText(row);
      if (text.length < 8) continue;
      candidates.push({ row, text, prose: row.querySelector(PROSE_SELECTORS) !== null });
    }
    if (candidates.length === 0) return null;

    // Prefer the newest row that actually renders markdown prose; fall back to
    // the newest non-empty row when the markup is unfamiliar.
    const proseCandidates = candidates.filter((candidate) => candidate.prose);
    const chosen = proseCandidates[proseCandidates.length - 1] ?? candidates[candidates.length - 1];
    if (chosen === undefined) return null;

    return { key: this.rowKey(chosen.row, chosen.text), text: chosen.text, anchor: chosen.row };
  }

  private rowKey(row: HTMLElement, text: string): string {
    const nodeKey = row.dataset["chatNodeKey"];
    if (nodeKey !== undefined && nodeKey !== "") return `node:${nodeKey}`;
    const anchorKey = row.dataset["chatAnchorKey"];
    if (anchorKey !== undefined && anchorKey !== "") return `anchor:${anchorKey}`;
    // Cheap content hash so a streaming reply does not create new cards forever.
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
    return `hash:${hash.toString(36)}`;
  }

  /**
   * Reply text for one row: drop tool calls, thinking, execution trace, action
   * bars and our own cards; keep prose and code fences.
   */
  private extractRowText(row: HTMLElement): string {
    const clone = row.cloneNode(true) as HTMLElement;
    for (const junk of clone.querySelectorAll(EXCLUDED_SUBTREES)) junk.remove();
    return elementToText(clone);
  }

  insertResponseCard(target: ResponseTarget, card: HTMLElement): void {
    const anchor = target.anchor.isConnected ? target.anchor : null;
    if (anchor === null) return;
    anchor.insertAdjacentElement("afterend", card);
  }

  observeResponses(callback: () => void): () => void {
    const scroller = document.querySelector<HTMLElement>(SCROLL_SELECTORS[0] ?? "");
    if (scroller === null) return () => {};

    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(callback, 900);
    });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      observer.disconnect();
    };
  }
}
