/** Typed messages exchanged between content scripts and the service worker. */

import type { GlossaryEntry } from "./protect.ts";
import type { TranslationFailureKind, TranslationRequest } from "./types.ts";

export interface TranslateMessage {
  type: "lb:translate";
  request: TranslationRequest;
  /** Overrides the stored glossary for one call (tests, ad-hoc runs). */
  glossary?: GlossaryEntry[];
}

export interface HealthMessage {
  type: "lb:health";
}

export interface PingMessage {
  type: "lb:ping";
}

export interface OpenSettingsMessage {
  type: "lb:open-settings";
}

/** Commands pushed from the service worker (keyboard shortcut, context menu). */
export interface CommandMessage {
  type: "lb:command";
  command: "translate-prompt" | "translate-selection";
}

export type RuntimeMessage = TranslateMessage | HealthMessage | PingMessage | OpenSettingsMessage | CommandMessage;

export interface TranslateOk {
  ok: true;
  translatedText: string;
  providerId: string;
  latencyMs: number;
  warnings: string[];
  detectedSourceLanguage?: string;
  /** Number of protected spans restored, for the panel's "format check ✓" badge. */
  restoredSlots: number;
  /** True when everything was code/URLs, so nothing was sent to the engine. */
  skipped: boolean;
}

export type TranslateFailureKind = TranslationFailureKind | "format-integrity" | "unknown";

export interface TranslateFail {
  ok: false;
  kind: TranslateFailureKind;
  message: string;
  /** Human-readable list of placeholders that could not be restored. */
  invalidSlots?: Array<{ kind: string; preview: string }>;
}

export type TranslateReply = TranslateOk | TranslateFail;

export interface HealthReply {
  ok: true;
  healthy: boolean;
  endpoint: string;
  latencyMs: number;
  hasChineseEnglishPair: boolean;
  languages: string[];
  message?: string;
}

export interface PingReply {
  ok: true;
  version: string;
}

/** Send a message and surface a clear error when the worker is gone. */
export async function sendRuntimeMessage<T>(message: RuntimeMessage): Promise<T> {
  try {
    const reply = await chrome.runtime.sendMessage(message);
    if (reply === undefined || reply === null) {
      throw new Error("扩展后台没有返回结果，请刷新页面后重试。");
    }
    return reply as T;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/Extension context invalidated|Receiving end does not exist|message port closed/i.test(text)) {
      throw new Error("扩展已重新加载，请刷新页面后再试。");
    }
    throw error;
  }
}
