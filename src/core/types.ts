/** Shared contracts between the background worker, content scripts and tests. */

export type TranslationMode = "prompt" | "response" | "plain";

export type ChineseVariant = "simplified" | "traditional" | "auto";

export interface TranslationRequest {
  text: string;
  sourceLanguage: string | "auto";
  targetLanguage: string;
  mode: TranslationMode;
  chineseVariant?: ChineseVariant;
}

export interface TranslationResult {
  translatedText: string;
  providerId: string;
  latencyMs: number;
  /** Non-fatal remarks, e.g. the engine dropped a paragraph. */
  warnings?: string[];
  detectedSourceLanguage?: string;
}

export interface ProviderLanguage {
  code: string;
  name: string;
  targets: string[];
}

export interface HealthResult {
  ok: boolean;
  endpoint: string;
  version?: string;
  /** Language pairs the local engine reports as installed. */
  languages: ProviderLanguage[];
  /** True when zh→en and en→zh are both available. */
  hasChineseEnglishPair: boolean;
  latencyMs: number;
  message?: string;
}

export type TranslationFailureKind =
  | "unreachable"
  | "timeout"
  | "http"
  | "bad-response"
  | "empty"
  | "aborted";

export class TranslationError extends Error {
  readonly kind: TranslationFailureKind;
  readonly userMessage: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(
    kind: TranslationFailureKind,
    userMessage: string,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(userMessage);
    this.name = "TranslationError";
    this.kind = kind;
    this.userMessage = userMessage;
    this.status = options.status;
    this.detail = options.detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
