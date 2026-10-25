import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runPipeline } from "../src/core/pipeline.ts";
import type { TranslationProvider } from "../src/core/provider.ts";
import type { HealthResult, TranslationRequest, TranslationResult } from "../src/core/types.ts";

class FakeProvider implements TranslationProvider {
  readonly id = "fake";
  calls: TranslationRequest[] = [];
  private readonly translateCore: (text: string) => string;

  constructor(translateCore: (text: string) => string) {
    this.translateCore = translateCore;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.calls.push(request);
    return {
      translatedText: this.translateCore(request.text),
      providerId: this.id,
      latencyMs: 3,
      detectedSourceLanguage: "zh",
    };
  }

  async health(): Promise<HealthResult> {
    return {
      ok: true,
      endpoint: "http://127.0.0.1:5000",
      languages: [],
      hasChineseEnglishPair: true,
      latencyMs: 1,
    };
  }
}

const DICTIONARY: Record<string, string> = {
  请解释这段代码: "Please explain this code",
  保留缩进: "keep the indentation",
};

function dictionary(text: string): string {
  let output = text;
  for (const [source, target] of Object.entries(DICTIONARY)) {
    output = output.split(source).join(target);
  }
  return output;
}

describe("translation pipeline", () => {
  it("never sends protected spans to the engine and copies them verbatim", async () => {
    const provider = new FakeProvider(dictionary);
    const source = "请解释这段代码：\n```ts\nconst answer: number = 42;\n```\n保留缩进。";

    const outcome = await runPipeline({
      text: source,
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });

    assert.equal(outcome.skipped, false);
    assert.equal(outcome.restoredSlots, 1);
    assert.equal(provider.calls.length, 2, "one call per prose fragment");
    for (const call of provider.calls) {
      assert.ok(!call.text.includes("const answer"), `code leaked into a call: ${call.text}`);
    }
    // The fence, its newlines and its indentation are byte-identical.
    assert.ok(outcome.translatedText.includes("\n```ts\nconst answer: number = 42;\n```\n"));
    assert.ok(outcome.translatedText.startsWith("Please explain this code"));
    assert.ok(outcome.translatedText.includes("keep the indentation"));
  });

  it("preserves whitespace around protected spans", async () => {
    const provider = new FakeProvider(() => "translated");
    const outcome = await runPipeline({
      text: "前文 `code` 后文",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.equal(outcome.translatedText, "translated `code` translated");
  });

  it("keeps the source fragment when the engine returns nothing", async () => {
    const provider = new FakeProvider(() => "");
    const outcome = await runPipeline({
      text: "请解释这段代码。",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.equal(outcome.translatedText, "请解释这段代码。");
    assert.ok(outcome.warnings.some((warning) => warning.includes("未能翻译")));
  });

  it("skips the engine when the input is already English", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("should not be called");
    });
    const outcome = await runPipeline({
      text: "Refactor this function and keep the public API stable.",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.equal(outcome.skipped, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(outcome.translatedText, "Refactor this function and keep the public API stable.");
  });

  it("skips the engine when the input is only code", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("should not be called");
    });
    const outcome = await runPipeline({
      text: "```python\nprint('hello')\n```",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.equal(outcome.skipped, true);
    assert.equal(provider.calls.length, 0);
  });

  it("reports constraint warnings in the result", async () => {
    const provider = new FakeProvider(() => "Consider using async functions.");
    const outcome = await runPipeline({
      text: "必须使用 async 函数。",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.ok(outcome.constraints.some((warning) => warning.ruleId === "obligation"));
    assert.ok(outcome.warnings.length > 0);
  });

  it("keeps glossary terms out of the engine call", async () => {
    const provider = new FakeProvider((text) => text);
    const outcome = await runPipeline({
      text: "请用 TypeScript 实现这个泛型工具。",
      provider,
      targetLanguage: "en",
      mode: "prompt",
      glossary: [{ source: "泛型", target: "generics" }],
    });
    for (const call of provider.calls) {
      assert.ok(!call.text.includes("泛型"), "glossary term must be masked before the call");
    }
    assert.ok(outcome.translatedText.includes("generics"));
  });

  it("does not call the engine for punctuation-only fragments", async () => {
    const provider = new FakeProvider(() => "Look at this:");
    const outcome = await runPipeline({
      text: "看这个：`a`，`b`",
      provider,
      targetLanguage: "en",
      mode: "prompt",
    });
    assert.equal(provider.calls.length, 1, "only the prose fragment is translated");
    // Full-width punctuation stays outside the spans but is normalised for English.
    assert.equal(outcome.translatedText, "Look at this:`a`,`b`");
    assert.equal(outcome.restoredSlots, 2);
  });

  it("rejects empty input", async () => {
    const provider = new FakeProvider(dictionary);
    await assert.rejects(() =>
      runPipeline({ text: "   ", provider, targetLanguage: "en", mode: "prompt" }),
    );
  });
});
