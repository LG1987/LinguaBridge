import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkConstraints, summarizeConstraints } from "../src/core/constraints.ts";

describe("constraint guard", () => {
  it("warns when 必须 loses its force", () => {
    const warnings = checkConstraints("必须使用 async 函数。", "Consider using async functions.");
    assert.ok(warnings.some((warning) => warning.ruleId === "obligation"));
  });

  it("stays quiet when must survives", () => {
    const warnings = checkConstraints("必须使用 async 函数。", "You must use an async function.");
    assert.equal(warnings.filter((warning) => warning.ruleId === "obligation").length, 0);
  });

  it("warns when a negation disappears entirely", () => {
    const warnings = checkConstraints("不要修改配置文件。", "Modify the configuration file.");
    assert.ok(warnings.some((warning) => warning.ruleId === "negation"));
    assert.ok(warnings.some((warning) => warning.ruleId === "prohibition"));
  });

  it("accepts a correct negation", () => {
    const warnings = checkConstraints("不要修改配置文件。", "Do not modify the configuration file.");
    assert.equal(warnings.filter((warning) => warning.ruleId === "negation").length, 0);
    assert.equal(warnings.filter((warning) => warning.ruleId === "prohibition").length, 0);
  });

  it("checks output-only phrasing", () => {
    const warnings = checkConstraints("只输出 JSON，不要解释。", "Return JSON and explain your reasoning.");
    assert.ok(warnings.some((warning) => warning.ruleId === "only-output"));
    assert.ok(warnings.some((warning) => warning.ruleId === "negation"));
  });

  it("checks numeric bounds", () => {
    const warnings = checkConstraints("回答不超过 200 字。", "Answer in about 200 words.");
    assert.ok(warnings.some((warning) => warning.ruleId === "bounds"));
  });

  it("reports nothing for constraint-free prose", () => {
    const warnings = checkConstraints("解释一下这段代码。", "Explain this code.");
    assert.deepEqual(warnings, []);
    assert.equal(summarizeConstraints(warnings), undefined);
  });

  it("summarises warnings for the panel", () => {
    const warnings = checkConstraints("必须且不要解释。", "Explain it.");
    const summary = summarizeConstraints(warnings);
    assert.ok(summary !== undefined);
    assert.ok(summary?.startsWith("• "));
  });
});
