/**
 * Translation providers.
 *
 * Only one implementation ships today — `LibreTranslateProvider` — but the
 * interface is deliberately narrow so a local LLM translator or a second engine
 * can be dropped in without touching the UI or the adapters.
 *
 * All network calls happen in the background service worker: it holds the host
 * permissions, so page CSP, CORS and "mixed content" rules never apply.
 */

import {
  TranslationError,
  type HealthResult,
  type ProviderLanguage,
  type TranslationRequest,
  type TranslationResult,
} from "./types.ts";

export interface TranslationProvider {
  readonly id: string;
  translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult>;
  health(signal?: AbortSignal): Promise<HealthResult>;
}

export interface ProviderOptions {
  /** Base URL, e.g. `http://127.0.0.1:5000`. */
  endpoint: string;
  /** Default ceiling for a request, before per-length adjustment. */
  timeoutMs: number;
  /** Optional API key (LibreTranslate supports `api_key`). */
  apiKey?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface TimeoutOptions {
  /** Total budget in milliseconds. */
  timeoutMs: number;
  /** Caller-supplied cancellation (panel closed, page navigated). */
  signal?: AbortSignal;
}

const SHORT_TEXT_CHARS = 120;

/**
 * The plan asks for 8s on short prompts and 15–20s on long ones: Argos decodes
 * sequence-by-sequence, so a 3k-character prompt legitimately takes longer.
 */
export function computeTimeoutMs(text: string, configured: number): number {
  const base = Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  if (text.length <= SHORT_TEXT_CHARS) return Math.min(base, 8_000);
  const scaled = Math.round(base * Math.min(2, 1 + text.length / 2_000));
  return Math.max(8_000, Math.min(scaled, 30_000));
}

function timeoutSignal({ timeoutMs, signal }: TimeoutOptions): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
    didTimeout: () => timedOut,
  };
}

export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "http://127.0.0.1:5000";
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

interface LibreTranslateResponse {
  translatedText?: unknown;
  detectedLanguage?: { language?: unknown; confidence?: unknown } | null;
  error?: unknown;
}

export class LibreTranslateProvider implements TranslationProvider {
  readonly id = "libretranslate-local";
  readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProviderOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.timeoutMs = options.timeoutMs;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async translate(request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult> {
    const text = request.text;
    if (text.trim() === "") {
      throw new TranslationError("empty", "没有可翻译的内容。");
    }
    const timeoutMs = computeTimeoutMs(text, this.timeoutMs);
    const started = performance.now();
    const guard = timeoutSignal({ timeoutMs, signal });

    try {
      const body: Record<string, unknown> = {
        q: text,
        source: request.sourceLanguage,
        target: request.targetLanguage,
        format: "text",
      };
      if (this.apiKey !== undefined) body["api_key"] = this.apiKey;

      const response = await this.fetchImpl(`${this.endpoint}/translate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: guard.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new TranslationError(
          "http",
          `本地翻译服务返回 HTTP ${response.status}。${httpHint(response.status)}`,
          { status: response.status, detail: detail.slice(0, 300) },
        );
      }

      const payload = (await response.json().catch(() => null)) as LibreTranslateResponse | null;
      if (payload === null || typeof payload !== "object") {
        throw new TranslationError("bad-response", "本地翻译服务返回了无法解析的响应。");
      }

      const translated = payload.translatedText;
      if (typeof payload.error === "string" && payload.error.length > 0) {
        throw new TranslationError("bad-response", `本地翻译服务报错：${payload.error}`);
      }
      if (typeof translated !== "string") {
        throw new TranslationError("bad-response", "本地翻译服务响应缺少 translatedText 字段。");
      }
      if (translated.trim() === "") {
        throw new TranslationError("empty", "本地翻译服务返回了空译文，已保留原文。");
      }

      const language = payload.detectedLanguage?.language;
      const result: TranslationResult = {
        translatedText: translated,
        providerId: this.id,
        latencyMs: Math.round(performance.now() - started),
      };
      if (typeof language === "string" && language !== "") {
        result.detectedSourceLanguage = language;
      }
      return result;
    } catch (error) {
      throw toTranslationError(error, guard.didTimeout(), timeoutMs);
    } finally {
      guard.cleanup();
    }
  }

  async health(signal?: AbortSignal): Promise<HealthResult> {
    const started = performance.now();
    const guard = timeoutSignal({ timeoutMs: 4_000, signal });
    try {
      const response = await this.fetchImpl(`${this.endpoint}/languages`, {
        method: "GET",
        signal: guard.signal,
      });
      if (!response.ok) {
        throw new TranslationError("http", `本地翻译服务返回 HTTP ${response.status}。`, {
          status: response.status,
        });
      }
      const payload: unknown = await response.json().catch(() => null);
      const languages = parseLanguages(payload);
      const codes = new Set(languages.map((language) => language.code));
      const zhToEn = languages.some(
        (language) => ["zh", "zt"].includes(language.code) && language.targets.includes("en"),
      );
      const enToZh = languages.some(
        (language) => language.code === "en" && language.targets.some((t) => t === "zh" || t === "zt"),
      );
      return {
        ok: true,
        endpoint: this.endpoint,
        languages,
        hasChineseEnglishPair: zhToEn && enToZh && codes.has("en"),
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const translated = toTranslationError(error, guard.didTimeout(), 4_000);
      return {
        ok: false,
        endpoint: this.endpoint,
        languages: [],
        hasChineseEnglishPair: false,
        latencyMs: Math.round(performance.now() - started),
        message: translated.userMessage,
      };
    } finally {
      guard.cleanup();
    }
  }
}

function parseLanguages(payload: unknown): ProviderLanguage[] {
  if (!Array.isArray(payload)) return [];
  const languages: ProviderLanguage[] = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const code = record["code"];
    if (typeof code !== "string") continue;
    const targets = Array.isArray(record["targets"])
      ? record["targets"].filter((value): value is string => typeof value === "string")
      : [];
    languages.push({
      code,
      name: typeof record["name"] === "string" ? record["name"] : code,
      targets,
    });
  }
  return languages;
}

function httpHint(status: number): string {
  if (status === 400) return "通常是语言对未安装，或 source/target 不受支持。";
  if (status === 429) return "请求过于频繁，稍后重试。";
  if (status >= 500) return "本地服务内部错误，请查看服务端日志。";
  return "";
}

function toTranslationError(error: unknown, didTimeout: boolean, timeoutMs: number): TranslationError {
  if (error instanceof TranslationError) return error;
  if (didTimeout) {
    return new TranslationError(
      "timeout",
      `本地翻译服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，已保留原文。`,
      { cause: error },
    );
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new TranslationError("aborted", "翻译已取消。", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  const looksLikeConnectFailure =
    error instanceof TypeError || /failed to fetch|networkerror|econnrefused|connection refused/i.test(message);
  if (looksLikeConnectFailure) {
    return new TranslationError(
      "unreachable",
      "连不上本地翻译服务（127.0.0.1）。请先启动本地服务，再重试。",
      { cause: error },
    );
  }
  return new TranslationError("bad-response", `翻译失败：${message}`, { cause: error });
}
