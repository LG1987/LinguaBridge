/**
 * Format protection for prompt translation.
 *
 * NMT engines happily rewrite things that must survive byte-for-byte: code,
 * URLs, file paths, env vars, shell commands. Every such span is lifted out and
 * replaced by a numeric placeholder (`[[3]]`), the remaining natural language is
 * translated, and the placeholders are substituted back.
 *
 * The restore step is *fail-closed*: if a placeholder is missing, duplicated or
 * invented, `restore()` reports it and the caller must refuse to write or send.
 */

export type SlotKind =
  | "fenced-code"
  | "inline-code"
  | "url"
  | "email"
  | "path"
  | "command"
  | "env-var"
  | "template"
  | "literal"
  | "glossary";

export interface ProtectedSlot {
  /** Placeholder that appears in the masked text, e.g. `[[2]]`. */
  token: string;
  /** Numeric id, also used for tolerant matching after translation. */
  index: number;
  kind: SlotKind;
  /** Exact original span. */
  original: string;
  /** Text put back during restore (differs from `original` for glossary hits). */
  restoredAs: string;
}

export interface MaskResult {
  masked: string;
  slots: ProtectedSlot[];
}

export interface RestoreResult {
  text: string;
  /** Slots the translation dropped — always a hard failure. */
  missing: ProtectedSlot[];
  /** Slots the translation repeated — always a hard failure. */
  duplicated: ProtectedSlot[];
  /** Placeholder ids in the translation that were never handed out. */
  unknownIndices: number[];
  ok: boolean;
}

export interface GlossaryEntry {
  /** Term in the source text. */
  source: string;
  /** Term to emit (defaults to `source`, i.e. preserve verbatim). */
  target?: string;
}

export interface ProtectOptions {
  /** Protect fenced/inline code, URLs, paths, commands, env vars. Default true. */
  preserveCode?: boolean;
  glossary?: ReadonlyArray<GlossaryEntry>;
}

/**
 * Tolerant matcher for placeholders after translation. Engines sometimes add
 * spaces or swap to full-width brackets; both are accepted.
 */
const PLACEHOLDER_SOURCE = String.raw`[\[［]\s*[\[［]\s*(\d{1,5})\s*[\]］]\s*[\]］]`;
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_SOURCE, "g");
/** Stateless copy used to reject matches that would swallow an existing slot. */
const PLACEHOLDER_TEST_RE = new RegExp(PLACEHOLDER_SOURCE);

/** Numeric ids already present in user text, so we never reuse one of them. */
function reservedIndices(text: string): Set<number> {
  const used = new Set<number>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) used.add(value);
  }
  return used;
}

interface Rule {
  kind: SlotKind;
  pattern: RegExp;
  /** Skip the match when this returns true (used for contextual rules). */
  skip?: (match: RegExpMatchArray) => boolean;
}

/**
 * Ordered rules. Later rules run on text that already contains placeholders for
 * earlier matches, which is why placeholders deliberately contain no letters.
 */
const RULES: Rule[] = [
  // Placeholder-looking text the user typed themselves: round-trip it verbatim
  // instead of mistaking it for a dropped/invented placeholder later.
  { kind: "literal", pattern: /[\[［]\s*[\[［]\s*\d{1,5}\s*[\]］]\s*[\]］]/g },
  // ```ts ... ``` / ~~~ ... ~~~ — closed fences only.
  // The lookbehind keeps the newline before the fence outside the match, and the
  // closing fence is anchored at a line start so trailing prose is never eaten.
  {
    kind: "fenced-code",
    pattern: /(?<=^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?<=\n)[ \t]*\1[ \t]*(?=\n|$)/g,
  },
  // Unterminated fence: protect to end of text rather than send raw code to the
  // engine. Runs after the closed-fence rule, so only leftovers match.
  {
    kind: "fenced-code",
    pattern: /(?<=^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g,
  },
  // `inline code` (single/double backticks, no newlines)
  { kind: "inline-code", pattern: /(`{1,2})([^`\n]+?)\1/g },
  // Email before URL: an email would otherwise be swallowed by the URL rule.
  { kind: "email", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  // http(s)://… and www.…
  { kind: "url", pattern: /\b(?:https?:\/\/|www\.)[^\s<>"'`）)\]】，。；]+/gi },
  // Windows drive paths, UNC paths, POSIX absolute paths, and relative file paths.
  { kind: "path", pattern: /\b[A-Za-z]:\\[^\s<>"'`|?*，。；)]+/g },
  { kind: "path", pattern: /\\\\[\w.$-]+\\[^\s<>"'`，。；)]+/g },
  { kind: "path", pattern: /(?<=\s|^)\/(?:[\w.@+-]+\/)+[\w.@+-]*/g },
  { kind: "path", pattern: /(?<![\w/])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][\w]{0,7}\b/g },
  // Shell commands: known executable followed by at least one ASCII argument.
  {
    kind: "command",
    pattern:
      /(?<![\w`])(?:npm|pnpm|yarn|npx|bun|deno|git|gh|docker|kubectl|helm|terraform|gcloud|az|cargo|rustc|go|python|py|pip|node|dotnet|msbuild|nuget|cmake|make|curl|wget|pwsh|powershell|choco|winget|ffmpeg|ssh|scp|rsync|tar|zip|unzip|java|javac|mvn|gradle|tsc|vite|vitest|jest|eslint|prettier|pytest|uv|uvx)(?:\s+(?=[^\s]*[A-Za-z0-9._/\\:@=+~$%{}[\]()"'<>*|&;^-])[^\s，。；：！？、（）]+)+/g,
  },
  // Environment variables: $env:NAME, $NAME, ${NAME}, %NAME%
  { kind: "env-var", pattern: /\$env:[A-Za-z_][\w]*/g },
  { kind: "env-var", pattern: /\$\{[A-Za-z_][\w]*\}/g },
  { kind: "env-var", pattern: /(?<![\w$])\$[A-Za-z_][\w]*/g },
  { kind: "env-var", pattern: /%[A-Za-z_][\w]*%/g },
  // {{handlebars}} style placeholders
  { kind: "template", pattern: /\{\{[^{}\n]+\}\}/g },
];

/** Apply one rule to the current masked text, appending new slots. */function applyRule(
  state: MaskResult,
  rule: Rule,
  nextIndex: () => number,
): void {
  const replaced = state.masked.replace(rule.pattern, (...args) => {
    // `args` ends with offset and the full input string.
    const groups = args.slice(0, -2) as Array<string | undefined>;
    const match = groups as unknown as RegExpMatchArray;
    if (match[0] === undefined) return "";
    if (rule.skip?.(match)) return match[0];

    const original = match[0];
    // A later rule must never eat an earlier placeholder: `curl <url>` would
    // otherwise become one command slot whose text still contains `[[2]]`,
    // orphaning the URL slot. Leave such matches to the rules that already ran.
    // (The `literal` rule is exempt: protecting user-typed `[[1]]` is its job.)
    if (rule.kind !== "literal" && PLACEHOLDER_TEST_RE.test(original)) return original;
    const index = nextIndex();
    const slot: ProtectedSlot = {
      token: `[[${index}]]`,
      index,
      kind: rule.kind,
      original,
      restoredAs: original,
    };
    state.slots.push(slot);
    return slot.token;
  });
  state.masked = replaced;
}

function applyGlossary(
  state: MaskResult,
  glossary: ReadonlyArray<GlossaryEntry>,
  nextIndex: () => number,
): void {
  const entries = [...glossary]
    .filter((entry) => entry.source.trim().length > 0)
    .sort((a, b) => b.source.length - a.source.length);

  for (const entry of entries) {
    const escaped = entry.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isAsciiTerm = /^[\x20-\x7e]+$/.test(entry.source);
    // ASCII terms need word boundaries, otherwise `Go` would hit `Google`.
    const pattern = new RegExp(isAsciiTerm ? `\\b${escaped}\\b` : escaped, "g");
    state.masked = state.masked.replace(pattern, (hit) => {
      const index = nextIndex();
      const slot: ProtectedSlot = {
        token: `[[${index}]]`,
        index,
        kind: "glossary",
        original: hit,
        restoredAs: entry.target ?? entry.source,
      };
      state.slots.push(slot);
      return slot.token;
    });
  }
}

/** Lift out every protected span and replace it with a placeholder. */
export function mask(text: string, options: ProtectOptions = {}): MaskResult {
  const state: MaskResult = { masked: text, slots: [] };
  const used = reservedIndices(text);
  let counter = 0;
  const nextIndex = () => {
    do {
      counter += 1;
    } while (used.has(counter));
    used.add(counter);
    return counter;
  };

  if (options.preserveCode !== false) {
    for (const rule of RULES) applyRule(state, rule, nextIndex);
  }
  if (options.glossary && options.glossary.length > 0) {
    applyGlossary(state, options.glossary, nextIndex);
  }
  return state;
}

/** Substitute placeholders back. Reports every integrity problem instead of guessing. */
export function restore(translated: string, slots: ReadonlyArray<ProtectedSlot>): RestoreResult {
  const byIndex = new Map<number, ProtectedSlot>();
  for (const slot of slots) byIndex.set(slot.index, slot);

  const counts = new Map<number, number>();
  const unknownIndices: number[] = [];
  for (const match of translated.matchAll(PLACEHOLDER_RE)) {
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index)) continue;
    if (!byIndex.has(index)) {
      if (!unknownIndices.includes(index)) unknownIndices.push(index);
      continue;
    }
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }

  const text = translated.replace(PLACEHOLDER_RE, (whole, digits: string) => {
    const slot = byIndex.get(Number(digits));
    return slot === undefined ? whole : slot.restoredAs;
  });

  const missing = slots.filter((slot) => (counts.get(slot.index) ?? 0) === 0);
  const duplicated = slots.filter((slot) => (counts.get(slot.index) ?? 0) > 1);

  return {
    text,
    missing,
    duplicated,
    unknownIndices,
    ok: missing.length === 0 && duplicated.length === 0 && unknownIndices.length === 0,
  };
}

/**
 * Split masked text back into alternating prose and protected spans.
 *
 * The pipeline translates only the `text` segments and copies the `protected`
 * segments through untouched. That makes byte-exact restoration structural
 * rather than a model behaviour we have to hope for: the engine never sees the
 * code, so it cannot lose it. (Measured against the bundled Argos model, `[[1]]`
 * placeholders were dropped or corrupted in most prompts.)
 */
export type Segment =
  | { kind: "text"; value: string }
  | { kind: "protected"; value: string; slot: ProtectedSlot };

export function toSegments(masked: MaskResult): Segment[] {
  const byToken = new Map<string, ProtectedSlot>();
  for (const slot of masked.slots) byToken.set(slot.token, slot);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of masked.masked.matchAll(PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: "text", value: masked.masked.slice(cursor, index) });
    }
    const slot = byToken.get(match[0]) ?? masked.slots.find((entry) => entry.index === Number(match[1]));
    if (slot !== undefined) {
      segments.push({ kind: "protected", value: slot.restoredAs, slot });
    } else {
      // Should be unreachable: the token came from this mask result.
      segments.push({ kind: "text", value: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < masked.masked.length) {
    segments.push({ kind: "text", value: masked.masked.slice(cursor) });
  }
  return segments;
}

/** True when the text has at least one CJK ideograph — used to decide whether a
 * prompt still needs translating at all.
 */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

/** Heuristic: text is mostly English prose, so nothing needs to be translated. */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk === 0 && letters >= 3;
}
