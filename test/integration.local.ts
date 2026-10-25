/**
 * Live integration test: the real local engine behind the real pipeline.
 *
 * Skipped automatically when no engine is listening, so the suite stays green on
 * machines without the models. Start one with `tools/start-engine.ps1`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runPipeline } from "../src/core/pipeline.ts";
import { LibreTranslateProvider } from "../src/core/provider.ts";

const ENDPOINT = process.env["LB_ENDPOINT"] ?? "http://127.0.0.1:5000";
const provider = new LibreTranslateProvider({ endpoint: ENDPOINT, timeoutMs: 25_000 });

async function serviceUp(): Promise<boolean> {
  try {
    const health = await provider.health();
    return health.ok && health.hasChineseEnglishPair;
  } catch {
    return false;
  }
}

const PROMPT = [
  "必须保留下面代码的缩进和函数名，不要改写实现，只补充注释。",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "```",
  "完成后运行 `npm test`，并把结果写到 C:\\work\\report.md。",
].join("\n");

describe("live local engine", () => {
  it("translates a prompt and restores every protected span byte-for-byte", async (t) => {
    if (!(await serviceUp())) {
      t.skip(`no engine on ${ENDPOINT}`);
      return;
    }

    const outcome = await runPipeline({
      text: PROMPT,
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });

    assert.equal(outcome.skipped, false);
    assert.ok(outcome.restoredSlots >= 3, `expected >=3 protected spans, got ${outcome.restoredSlots}`);

    // Code block, including indentation, must survive unchanged.
    assert.ok(
      outcome.translatedText.includes("export function add(a: number, b: number): number {"),
      "code line missing from translation",
    );
    assert.ok(outcome.translatedText.includes("\n  return a + b;\n"), "code indentation changed");
    assert.ok(outcome.translatedText.includes("`npm test`"), "inline code missing");
    assert.ok(outcome.translatedText.includes("C:\\work\\report.md"), "path missing");

    // The prose itself must actually have been translated.
    assert.ok(!/[\u4e00-\u9fff]/.test(outcome.translatedText.replace(/`[^`]*`/g, "")), "Chinese prose left untranslated");

    console.log(`\n  [zh->en ${outcome.latencyMs}ms, ${outcome.restoredSlots} spans]`);
    console.log(`  ${outcome.translatedText.replace(/\n/g, " ⏎ ")}`);
    if (outcome.warnings.length > 0) console.log(`  warnings: ${outcome.warnings.join(" | ")}`);
  });

  it("translates an English reply into Chinese", async (t) => {
    if (!(await serviceUp())) {
      t.skip(`no engine on ${ENDPOINT}`);
      return;
    }

    const outcome = await runPipeline({
      text: "A generic type lets you write a function that works with many types while keeping type safety. Do not use any.",
      provider,
      targetLanguage: "zh",
      mode: "response",
    });

    assert.ok(/[\u4e00-\u9fff]/.test(outcome.translatedText), "expected Chinese output");
    console.log(`\n  [en->zh ${outcome.latencyMs}ms]`);
    console.log(`  ${outcome.translatedText}`);
  });

  it("keeps the glossary term out of the engine", async (t) => {
    if (!(await serviceUp())) {
      t.skip(`no engine on ${ENDPOINT}`);
      return;
    }

    const outcome = await runPipeline({
      text: "请解释 TypeScript 泛型，并给出一个例子。",
      provider,
      targetLanguage: "en",
      mode: "prompt",
      glossary: [{ source: "泛型", target: "generics" }],
    });

    assert.ok(outcome.translatedText.includes("generics"), "glossary target missing");
    assert.ok(!outcome.translatedText.includes("泛型"), "glossary source leaked through");
    console.log(`\n  [glossary] ${outcome.translatedText}`);
  });
});
