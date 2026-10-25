/**
 * Translation pipeline: protect → translate prose only → reassemble → verify.
 *
 * Why not placeholder substitution? Measured against the bundled Argos model,
 * `[[1]]`-style placeholders were dropped, collapsed to `[1]`, or replaced by
 * hallucinated text ("[ Chuckles ]") in ordinary prompts. Instead the text is
 * cut at every protected span and only the prose between spans is sent to the
 * engine. Protected spans are copied from the original string, so format
 * integrity is structural — the engine cannot lose what it never receives.
 *
 * Kept free of DOM and chrome APIs so it can be unit-tested directly.
 */

import { checkConstraints, type ConstraintWarning } from "./constraints.ts";
import { hasCjk, mask, toSegments, type GlossaryEntry, type ProtectedSlot, type Segment } from "./protect.ts";
import type { TranslationProvider } from "./provider.ts";
import { TranslationError, type ChineseVariant, type TranslationMode } from "./types.ts";

export interface InvalidSlot {
  kind: string;
  /** Short excerpt of the original span, shown to the user for manual repair. */
  preview: string;
}

/** Raised when reassembly lost a protected span. Never expected; always fatal. */
export class FormatIntegrityError extends Error {
  readonly invalidSlots: InvalidSlot[];

  constructor(invalidSlots: InvalidSlot[]) {
    super("译文格式校验失败：受保护的代码/链接在重组时丢失。已拒绝写入，请手动翻译这段内容。");
    this.name = "FormatIntegrityError";
    this.invalidSlots = invalidSlots;
  }
}

export interface PipelineOptions {
  text: string;
  provider: TranslationProvider;
  targetLanguage: string;
  sourceLanguage?: string | "auto";
  mode: TranslationMode;
  preserveCode?: boolean;
  glossary?: ReadonlyArray<GlossaryEntry>;
  chineseVariant?: ChineseVariant;
  signal?: AbortSignal;
}

export interface PipelineOutcome {
  translatedText: string;
  providerId: string;
  latencyMs: number;
  warnings: string[];
  detectedSourceLanguage?: string;
  /** Number of protected spans carried through untouched. */
  restoredSlots: number;
  /** True when no engine call was needed (already English, or pure code). */
  skipped: boolean;
  constraints: ConstraintWarning[];
}

const EDGE_RE = /^(\s*)([\s\S]*?)(\s*)$/;

/** Full-width punctuation → ASCII, applied only to translated prose (never to code). */
const CJK_PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/，/g, ","],
  [/。/g, "."],
  [/；/g, ";"],
  [/：/g, ":"],
  [/！/g, "!"],
  [/？/g, "?"],
  [/（/g, "("],
  [/）/g, ")"],
  [/、/g, ","],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, "..."],
];

function normalizePunctuation(text: string, targetIsEnglish: boolean): string {
  if (!targetIsEnglish) return text;
  let output = text;
  for (const [pattern, replacement] of CJK_PUNCTUATION) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

// A Latin word on both sides of a piece boundary needs a separating space, which
// Chinese source text never has: "运行 `npm test`并写出" → "run `npm test` and …".
const LATIN_TAIL_RE = /[A-Za-z0-9)\]"'`]$/;
const LATIN_HEAD_RE = /^[A-Za-z0-9($"'`[]/;

function joinPieces(pieces: readonly string[], targetIsEnglish: boolean): string {
  let output = "";
  for (const piece of pieces) {
    if (piece === "") continue;
    if (output !== "" && targetIsEnglish) {
      const tail = output[output.length - 1] ?? "";
      const head = piece[0] ?? "";
      if (LATIN_TAIL_RE.test(tail) && LATIN_HEAD_RE.test(head)) output += " ";
    }
    output += piece;
  }
  return output;
}

function splitEdges(chunk: string): { lead: string; core: string; trail: string } {
  const match = EDGE_RE.exec(chunk);
  if (match === null) return { lead: "", core: chunk, trail: "" };
  return { lead: match[1] ?? "", core: match[2] ?? "", trail: match[3] ?? "" };
}

/** Punctuation-only or emoji-only fragments are not worth an engine call. */
function hasTranslatableChars(text: string): boolean {
  return /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

interface ChunkOutcome {
  text: string;
  providerId: string;
  latencyMs: number;
  detectedSourceLanguage?: string;
  translated: boolean;
}

async function translateChunk(
  core: string,
  options: PipelineOptions,
): Promise<ChunkOutcome> {
  const result = await options.provider.translate(
    {
      text: core,
      sourceLanguage: options.sourceLanguage ?? "auto",
      targetLanguage: options.targetLanguage,
      mode: options.mode,
      ...(options.chineseVariant !== undefined ? { chineseVariant: options.chineseVariant } : {}),
    },
    options.signal,
  );
  return {
    text: result.translatedText.trim(),
    providerId: result.providerId,
    latencyMs: result.latencyMs,
    ...(result.detectedSourceLanguage !== undefined
      ? { detectedSourceLanguage: result.detectedSourceLanguage }
      : {}),
    translated: true,
  };
}

function previewOf(slot: ProtectedSlot): InvalidSlot {
  return {
    kind: slot.kind,
    preview: slot.original.length > 60 ? `${slot.original.slice(0, 60)}…` : slot.original,
  };
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineOutcome> {
  const text = options.text;
  if (text.trim() === "") {
    throw new TranslationError("empty", "输入框是空的，没有可翻译的内容。");
  }

  const target = options.targetLanguage;
  const isEnglishTarget = target.toLowerCase().startsWith("en");

  // Nothing to do when the user already wrote English for an English target.
  if (isEnglishTarget && !hasCjk(text)) {
    return {
      translatedText: text,
      providerId: "none",
      latencyMs: 0,
      warnings: ["输入看起来已经是英文，未调用翻译引擎。"],
      restoredSlots: 0,
      skipped: true,
      constraints: [],
    };
  }

  const masked = mask(text, {
    preserveCode: options.preserveCode !== false,
    ...(options.glossary !== undefined ? { glossary: options.glossary } : {}),
  });
  const segments: Segment[] = toSegments(masked);
  const protectedCount = segments.filter((segment) => segment.kind === "protected").length;

  const proseSegments = segments.filter(
    (segment) => segment.kind === "text" && splitEdges(segment.value).core !== "",
  );
  if (proseSegments.length === 0) {
    return {
      translatedText: text,
      providerId: "none",
      latencyMs: 0,
      warnings: ["内容全部是代码、链接或占位符，已跳过翻译并保持原样。"],
      restoredSlots: protectedCount,
      skipped: true,
      constraints: [],
    };
  }

  const warnings: string[] = [];
  let providerId = "none";
  let totalLatency = 0;
  let detectedSourceLanguage: string | undefined;
  let untranslatedChunks = 0;

  const pieces: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "protected") {
      pieces.push(segment.value);
      continue;
    }

    const { lead, core, trail } = splitEdges(segment.value);
    if (core === "" || !hasTranslatableChars(core)) {
      // Punctuation-only fragments stay as-is structurally, but full-width
      // punctuation still reads wrong in English output.
      pieces.push(normalizePunctuation(segment.value, isEnglishTarget));
      continue;
    }

    const outcome = await translateChunk(core, options);
    providerId = outcome.providerId;
    totalLatency += outcome.latencyMs;
    if (detectedSourceLanguage === undefined && outcome.detectedSourceLanguage !== undefined) {
      detectedSourceLanguage = outcome.detectedSourceLanguage;
    }

    if (outcome.text === "") {
      // Fail soft per chunk: keep the source fragment (visible to the user in the
      // comparison panel) and tell them it was not translated.
      untranslatedChunks += 1;
      pieces.push(segment.value);
      continue;
    }
    pieces.push(`${lead}${normalizePunctuation(outcome.text, isEnglishTarget)}${trail}`);
  }

  if (untranslatedChunks > 0) {
    warnings.push(
      `有 ${untranslatedChunks} 段文字未能翻译，已保留原文片段；请对照原文手动补齐。`,
    );
  }

  const translatedText = joinPieces(pieces, isEnglishTarget);

  // Structural self-check: every protected span must still be present verbatim.
  const lost = masked.slots.filter((slot) => !translatedText.includes(slot.restoredAs));
  if (lost.length > 0) {
    throw new FormatIntegrityError(lost.map(previewOf));
  }

  const constraints =
    options.mode === "prompt" && hasCjk(text) && isEnglishTarget
      ? checkConstraints(text, translatedText)
      : [];
  warnings.push(...constraints.map((warning) => warning.message));

  return {
    translatedText,
    providerId,
    latencyMs: totalLatency,
    warnings,
    ...(detectedSourceLanguage !== undefined ? { detectedSourceLanguage } : {}),
    restoredSlots: protectedCount,
    skipped: false,
    constraints,
  };
}
