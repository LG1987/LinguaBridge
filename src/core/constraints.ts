/**
 * Constraint-word guard.
 *
 * Small NMT models silently weaken instructions: 必须 ("must") becomes "should",
 * 不得 ("must not") loses its negation, 只输出 ("output only") disappears. We
 * cannot fix the model, so after translation we check that each constraint seen
 * in the source still has an equivalent marker in the target and surface a
 * warning in the confirmation panel. Warnings never block the user, but they are
 * never silent either.
 */

export type ConstraintSeverity = "warning" | "info";

export interface ConstraintWarning {
  ruleId: string;
  severity: ConstraintSeverity;
  /** The source phrase that triggered the check. */
  sourceTerm: string;
  message: string;
}

interface ConstraintRule {
  id: string;
  /** Phrases that indicate the constraint in the source text. */
  sourceTerms: ReadonlyArray<string>;
  /** Markers that must appear in a correct translation. */
  targetMarkers: ReadonlyArray<RegExp>;
  message: string;
}

const RULES: ReadonlyArray<ConstraintRule> = [
  {
    id: "obligation",
    sourceTerms: ["必须", "务必", "一定要", "必需", "应当"],
    targetMarkers: [/\b(must|shall|required?|have to|has to|need to|ensure|make sure)\b/i],
    message: "原文含「必须/务必」，译文中没有 must/shall/ensure 之类的强制语气，可能被弱化。",
  },
  {
    id: "prohibition",
    sourceTerms: ["不得", "禁止", "严禁", "不准", "不要", "不能", "不可", "勿"],
    targetMarkers: [
      /\b(must not|mustn't|do not|don't|does not|doesn't|never|shall not|should not|shouldn't|cannot|can't|avoid|prohibited|forbidden|no)\b/i,
    ],
    message: "原文含否定/禁止类要求，译文中未找到 must not / do not / never 等否定词，否定约束可能丢失。",
  },
  {
    id: "only-output",
    sourceTerms: ["只输出", "仅输出", "只返回", "仅返回", "只回复", "仅回复", "不要解释", "无需解释", "只给"],
    targetMarkers: [
      /\b(only|solely|exclusively|just)\b/i,
      /\b(no explanation|without explanation|do not explain|don't explain)\b/i,
    ],
    message: "原文限制输出形式（只输出/不要解释），译文中未见 only/solely/no explanation 等限定。",
  },
  {
    id: "exclusivity",
    sourceTerms: ["只能", "仅可", "仅限", "唯一"],
    targetMarkers: [/\b(only|solely|exclusively|single|the one)\b/i],
    message: "原文含排他要求（只能/仅限），译文未体现 only/exclusively。",
  },
  {
    id: "bounds",
    sourceTerms: ["至少", "最多", "不超过", "不少于", "不多于", "以内", "以上"],
    targetMarkers: [
      /\b(at least|at most|no more than|no fewer than|no less than|maximum|minimum|up to|within)\b/i,
    ],
    message: "原文含数量上下限，译文中未见 at least/at most/no more than 等对应限制。",
  },
  {
    id: "conditional",
    sourceTerms: ["除非", "否则", "如果", "假如", "一旦"],
    targetMarkers: [/\b(unless|otherwise|if|when|once|in case)\b/i],
    message: "原文含条件分支词，译文未体现 unless/if/otherwise，条件关系可能被改写。",
  },
  {
    id: "preserve",
    sourceTerms: ["保持", "保留", "不变", "不要修改", "原样"],
    targetMarkers: [
      /\b(keep|preserve|retain|unchanged|do not (change|modify|alter)|don't (change|modify|alter)|as-is|verbatim)\b/i,
    ],
    message: "原文要求保持不变，译文未体现 keep/preserve/unchanged，修改边界可能被削弱。",
  },
  {
    id: "stepwise",
    sourceTerms: ["一步一步", "逐步", "分步骤", "按步骤"],
    targetMarkers: [/\b(step by step|step-by-step|incrementally|one step at a time)\b/i],
    message: "原文要求分步执行，译文未体现 step by step。",
  },
  {
    id: "language",
    sourceTerms: ["用中文", "用英文", "英文回答", "中文回答", "英文输出", "中文输出"],
    targetMarkers: [/\b(in (english|chinese)|english|chinese)\b/i],
    message: "原文指定了输出语言，请确认译文仍然表达了该语言要求。",
  },
  {
    id: "format",
    sourceTerms: ["JSON", "Markdown", "YAML", "SQL", "纯文本", "表格"],
    targetMarkers: [/\b(json|markdown|yaml|sql|plain text|table)\b/i],
    message: "原文指定了输出格式，译文中未见同名格式词，请人工确认。",
  },
];

/** Negation markers, used for a coarse "did the negation survive?" check. */
const NEGATION_SOURCE = /[不没别勿未]|禁止|避免/g;
const NEGATION_TARGET = /\b(not|no|never|none|neither|nor|without|cannot|can't|don't|doesn't|isn't|aren't|won't)\b/gi;

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/**
 * Compare constraints in the Chinese source against the English translation.
 * Returns warnings only; the caller decides how to present them.
 */
export function checkConstraints(source: string, translated: string): ConstraintWarning[] {
  const warnings: ConstraintWarning[] = [];

  for (const rule of RULES) {
    const hit = rule.sourceTerms.find((term) => source.includes(term));
    if (hit === undefined) continue;
    const satisfied = rule.targetMarkers.some((marker) => marker.test(translated));
    if (!satisfied) {
      warnings.push({
        ruleId: rule.id,
        severity: "warning",
        sourceTerm: hit,
        message: rule.message,
      });
    }
  }

  // Coarse negation-count check: catches "don't" turning into "do".
  const sourceNegations = countMatches(source, NEGATION_SOURCE);
  const targetNegations = countMatches(translated, NEGATION_TARGET);
  if (sourceNegations > 0 && targetNegations === 0) {
    warnings.push({
      ruleId: "negation",
      severity: "warning",
      sourceTerm: "否定词",
      message: "原文含否定表达，译文中完全没有否定词，请逐句核对。",
    });
  }

  return warnings;
}

/** Deduplicated, human-readable summary for the confirmation panel. */
export function summarizeConstraints(warnings: ReadonlyArray<ConstraintWarning>): string | undefined {
  if (warnings.length === 0) return undefined;
  return warnings.map((warning) => `• ${warning.message}`).join("\n");
}
