/**
 * User settings with the plan's safety defaults baked in.
 *
 * Storage lives in `chrome.storage.local` so content scripts and the service
 * worker see the same values without a message round-trip. When the extension
 * APIs are missing (unit tests, plain node), an in-memory fallback is used.
 */

import type { GlossaryEntry } from "./protect.ts";
import { normalizeEndpoint } from "./provider.ts";
import type { ChineseVariant } from "./types.ts";

export type InputMode = "manual" | "auto";
export type ResponseMode = "bilingual" | "off";

export interface LinguaBridgeSettings {
  provider: string;
  localEndpoint: string;
  /** Language prompts are translated into (usually English). */
  sendTargetLanguage: string;
  /** Language replies are translated into (usually Chinese). */
  readingLanguage: string;
  chineseVariant: ChineseVariant;
  inputMode: InputMode;
  responseMode: ResponseMode;
  /** Translate assistant replies automatically when they finish. */
  autoTranslateResponse: boolean;
  preserveCode: boolean;
  preserveMarkdown: boolean;
  saveHistory: boolean;
  timeoutMs: number;
  glossary: GlossaryEntry[];
  /**
   * Not surfaced as a toggle on purpose: the plan forbids sending without an
   * explicit click. Kept here so a future "insert & send" button can honour it.
   */
  allowAutoSend: boolean;
}

export const DEFAULT_SETTINGS: LinguaBridgeSettings = {
  provider: "libretranslate-local",
  localEndpoint: "http://127.0.0.1:5000",
  sendTargetLanguage: "en",
  readingLanguage: "zh",
  chineseVariant: "simplified",
  inputMode: "manual",
  responseMode: "bilingual",
  autoTranslateResponse: true,
  preserveCode: true,
  preserveMarkdown: true,
  saveHistory: false,
  timeoutMs: 15_000,
  glossary: [],
  allowAutoSend: false,
};

export const SETTINGS_KEY = "linguabridge.settings.v1";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Merge persisted data over the defaults, rejecting nonsense values. */
export function normalizeSettings(raw: unknown): LinguaBridgeSettings {
  const merged: LinguaBridgeSettings = { ...DEFAULT_SETTINGS };
  if (raw === null || typeof raw !== "object") return merged;
  const record = raw as Record<string, unknown>;

  const stringOr = (key: keyof LinguaBridgeSettings, fallback: string): string => {
    const value = record[key as string];
    return typeof value === "string" && value.trim() !== "" ? value : fallback;
  };

  merged.provider = stringOr("provider", DEFAULT_SETTINGS.provider);
  merged.localEndpoint = normalizeEndpoint(stringOr("localEndpoint", DEFAULT_SETTINGS.localEndpoint));
  merged.sendTargetLanguage = stringOr("sendTargetLanguage", DEFAULT_SETTINGS.sendTargetLanguage);
  merged.readingLanguage = stringOr("readingLanguage", DEFAULT_SETTINGS.readingLanguage);

  const variant = record["chineseVariant"];
  merged.chineseVariant =
    variant === "simplified" || variant === "traditional" || variant === "auto"
      ? variant
      : DEFAULT_SETTINGS.chineseVariant;

  merged.inputMode = record["inputMode"] === "auto" ? "auto" : "manual";
  merged.responseMode = record["responseMode"] === "off" ? "off" : "bilingual";

  for (const key of [
    "autoTranslateResponse",
    "preserveCode",
    "preserveMarkdown",
    "saveHistory",
    "allowAutoSend",
  ] as const) {
    const value = record[key];
    if (typeof value === "boolean") merged[key] = value;
  }

  merged.timeoutMs = clamp(Number(record["timeoutMs"] ?? DEFAULT_SETTINGS.timeoutMs), 3_000, 60_000);

  const glossary = record["glossary"];
  if (Array.isArray(glossary)) {
    merged.glossary = glossary
      .filter((entry): entry is GlossaryEntry => {
        if (entry === null || typeof entry !== "object") return false;
        const source = (entry as GlossaryEntry).source;
        return typeof source === "string" && source.trim() !== "";
      })
      .map((entry) => ({
        source: entry.source.trim(),
        ...(typeof entry.target === "string" && entry.target.trim() !== ""
          ? { target: entry.target.trim() }
          : {}),
      }))
      .slice(0, 200);
  }

  return merged;
}

function storageArea(): chrome.storage.StorageArea | null {
  try {
    return chrome?.storage?.local ?? null;
  } catch {
    return null;
  }
}

let memoryFallback: LinguaBridgeSettings | null = null;

export async function loadSettings(): Promise<LinguaBridgeSettings> {
  const area = storageArea();
  if (area === null) return memoryFallback ?? { ...DEFAULT_SETTINGS };
  try {
    const stored = await area.get(SETTINGS_KEY);
    const value = stored[SETTINGS_KEY];
    return normalizeSettings(value);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(next: LinguaBridgeSettings): Promise<LinguaBridgeSettings> {
  const normalized = normalizeSettings(next);
  const area = storageArea();
  if (area === null) {
    memoryFallback = normalized;
    return normalized;
  }
  await area.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export async function updateSettings(patch: Partial<LinguaBridgeSettings>): Promise<LinguaBridgeSettings> {
  const current = await loadSettings();
  return saveSettings({ ...current, ...patch });
}

/** Test-only helper: forget the in-memory settings. */
export function resetSettingsForTests(): void {
  memoryFallback = null;
}
