/** The contract each supported site implements. */

import type { WriteResult } from "../dom.ts";

export interface ResponseTarget {
  /** Stable identity for the reply, used to avoid duplicate cards. */
  key: string;
  /** Extracted reply text (markdown-ish, code fences preserved as newlines). */
  text: string;
  /** Row/message element the bilingual card is inserted after. */
  anchor: HTMLElement;
}

export interface SiteAdapter {
  readonly id: string;
  readonly label: string;
  /** Never guess from the port alone — check real DOM markers. */
  match(url: URL): boolean;
  getInputElement(): HTMLElement | null;
  readInput(): string;
  writeInput(text: string): WriteResult;
  /** Click the site's own send button (or press Enter). */
  send(): boolean;
  getLatestResponse(): ResponseTarget | null;
  /** Insert a card without touching the original message DOM. */
  insertResponseCard(target: ResponseTarget, card: HTMLElement): void;
  /** Observe the transcript; the callback fires after edits settle. */
  observeResponses(callback: () => void): () => void;
}
