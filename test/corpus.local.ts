/**
 * Corpus regression against the live local engine.
 *
 * Runs every prompt in `test/prompts/corpus.json` (34 prompts) through the real
 * pipeline and writes a machine-readable report. It asserts the gate that
 * matters: no protected span is ever lost, and skipped cases really skip.
 *
 * Skipped automatically when the engine is not running.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runPipeline } from "../src/core/pipeline.ts";
import { LibreTranslateProvider } from "../src/core/provider.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const ENDPOINT = process.env["LB_ENDPOINT"] ?? "http://127.0.0.1:5000";

interface CorpusPrompt {
  id: string;
  category: string;
  text: string;
  direction?: "zh->en" | "en->zh";
  expectSkipped?: boolean;
}

interface CorpusFile {
  prompts: CorpusPrompt[];
}

const provider = new LibreTranslateProvider({ endpoint: ENDPOINT, timeoutMs: 30_000 });

describe("prompt corpus", () => {
  it("preserves protected spans across every corpus prompt", async (t) => {
    const health = await provider.health();
    if (!health.ok || !health.hasChineseEnglishPair) {
      t.skip(`no engine on ${ENDPOINT}`);
      return;
    }

    const corpus = JSON.parse(await readFile(join(HERE, "prompts", "corpus.json"), "utf8")) as CorpusFile;
    const rows: Array<Record<string, unknown>> = [];
    let failures = 0;

    for (const prompt of corpus.prompts) {
      const englishResponse = prompt.direction === "en->zh";
      const started = performance.now();
      try {
        const outcome = await runPipeline({
          text: prompt.text,
          provider,
          targetLanguage: englishResponse ? "zh" : "en",
          mode: englishResponse ? "response" : "prompt",
        });

        if (prompt.expectSkipped === true && !outcome.skipped) {
          throw new Error("expected the pipeline to skip this input");
        }
        if (outcome.skipped !== true && outcome.translatedText.trim() === "") {
          throw new Error("empty translation");
        }

        rows.push({
          id: prompt.id,
          category: prompt.category,
          ok: true,
          skipped: outcome.skipped,
          spans: outcome.restoredSlots,
          warnings: outcome.warnings.length,
          ms: Math.round(performance.now() - started),
          chars: prompt.text.length,
        });
      } catch (error) {
        failures += 1;
        rows.push({
          id: prompt.id,
          category: prompt.category,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ms: Math.round(performance.now() - started),
        });
      }
    }

    const reportDir = join(ROOT, ".artifacts");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, "corpus-report.json");
    await writeFile(
      reportPath,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), endpoint: ENDPOINT, rows }, null, 2)}\n`,
      "utf8",
    );

    const translated = rows.filter((row) => row["ok"] === true);
    const totalMs = translated.reduce((sum, row) => sum + Number(row["ms"] ?? 0), 0);
    console.log(
      `\n  corpus: ${translated.length}/${corpus.prompts.length} ok, ${failures} failed, ` +
        `${(totalMs / 1000).toFixed(1)}s total → ${reportPath.replace(ROOT, ".")}`,
    );
    for (const row of rows.filter((entry) => entry["ok"] !== true)) {
      console.log(`    FAIL ${row["id"]}: ${row["error"]}`);
    }

    assert.equal(failures, 0, `${failures} corpus prompts failed`);
  });
});
