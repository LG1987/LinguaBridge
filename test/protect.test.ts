import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasCjk, looksEnglish, mask, restore } from "../src/core/protect.ts";

describe("mask/restore", () => {
  it("lifts a fenced code block out of the prose", () => {
    const source = "请解释下面这段代码，然后告诉我它的复杂度。\n```ts\nconst x: number = 1;\n```\n谢谢。";
    const masked = mask(source);
    assert.equal(masked.slots.length, 1);
    assert.equal(masked.slots[0]?.kind, "fenced-code");
    assert.ok(masked.slots[0]?.original.includes("const x: number = 1;"));
    assert.ok(!masked.masked.includes("const x"), "code must not reach the engine");
    assert.ok(masked.masked.includes("请解释下面这段代码"));
    // The newline before the fence survives, so the markdown layout is intact.
    assert.ok(masked.masked.includes("复杂度。\n[[1]]"));

    const restored = restore(masked.masked.replace("请解释", "Please explain"), masked.slots);
    assert.ok(restored.ok);
    assert.ok(restored.text.includes("```ts\nconst x: number = 1;\n```"));
  });

  it("never lets one rule swallow another rule's placeholder", () => {
    const source = "然后用 curl http://127.0.0.1:8080 确认服务可以访问。";
    const masked = mask(source);
    const kinds = masked.slots.map((slot) => slot.kind);
    assert.ok(kinds.includes("url"), "URL must be protected on its own");
    for (const slot of masked.slots) {
      assert.ok(
        !/\[\[\d+\]\]/.test(slot.original),
        `slot ${slot.kind} swallowed a placeholder: ${slot.original}`,
      );
    }
    const restored = restore(masked.masked, masked.slots);
    assert.equal(restored.ok, true);
    assert.equal(restored.text, source);
  });

  it("does not swallow the prose that follows a fenced block", () => {
    const source = "请解释这段代码：\n```ts\nconst answer: number = 42;\n```\n保留缩进。";
    const masked = mask(source);
    assert.equal(masked.slots.length, 1);
    assert.equal(masked.slots[0]?.original, "```ts\nconst answer: number = 42;\n```");
    assert.ok(masked.masked.endsWith("[[1]]\n保留缩进。"), `unexpected mask: ${masked.masked}`);
  });

  it("protects an unterminated fence to the end of the text", () => {
    const masked = mask("未闭合的代码块：\n```ts\nconst x = 1;\n更多代码");
    assert.equal(masked.slots.length, 1);
    assert.ok(masked.slots[0]?.original.includes("const x = 1;"));
    assert.ok(masked.masked.startsWith("未闭合的代码块：\n[[1]]"));
  });

  it("protects inline code, URLs, emails and paths", () => {
    const source =
      "运行 `npm test` 后把结果发到 dev@example.com，参考 https://example.com/docs 和 C:\\work\\app\\src\\main.ts 。";
    const masked = mask(source);
    const kinds = masked.slots.map((slot) => slot.kind);
    assert.ok(kinds.includes("inline-code"));
    assert.ok(kinds.includes("email"));
    assert.ok(kinds.includes("url"));
    assert.ok(kinds.includes("path"));

    for (const slot of masked.slots) {
      assert.ok(!masked.masked.includes(slot.original), `${slot.kind} should be masked`);
    }

    const restored = restore(masked.masked, masked.slots);
    assert.ok(restored.ok);
    assert.equal(restored.text, source);
  });

  it("protects shell commands and environment variables", () => {
    const source = "先执行 git commit -m 'fix login'，然后设置 $env:NODE_ENV 并重启。";
    const masked = mask(source);
    const kinds = masked.slots.map((slot) => slot.kind);
    assert.ok(kinds.includes("command"), `expected a command slot, got ${kinds.join(",")}`);
    assert.ok(kinds.includes("env-var"));

    const restored = restore(masked.masked, masked.slots);
    assert.equal(restored.text, source);
    assert.ok(restored.ok);
  });

  it("stops a command at Chinese text instead of swallowing the clause", () => {
    const source = "用 python 写一个脚本，读取 data.csv。";
    const masked = mask(source);
    const commands = masked.slots.filter((slot) => slot.kind === "command");
    for (const command of commands) {
      assert.ok(!/写/.test(command.original), `command ate Chinese text: ${command.original}`);
    }
  });

  it("protects {{template}} variables", () => {
    const source = "把 {{userName}} 替换成实际用户名，不要改动其他字段。";
    const masked = mask(source);
    assert.ok(masked.slots.some((slot) => slot.kind === "template"));
    const restored = restore(masked.masked, masked.slots);
    assert.equal(restored.text, source);
  });

  it("escapes pre-existing placeholder-looking text", () => {
    const source = "保留 [[1]] 这个字符串，翻译其余内容。";
    const masked = mask(source);
    // The literal [[1]] must not be reused as a placeholder id.
    const literal = masked.slots.find((slot) => slot.original === "[[1]]");
    assert.ok(literal !== undefined, "literal placeholder must be protected");
    assert.notEqual(literal?.token, "[[1]]");

    const restored = restore(masked.masked, masked.slots);
    assert.ok(restored.ok);
    assert.equal(restored.text, source);
  });

  it("tolerates spacing and full-width brackets added by the engine", () => {
    const source = "运行 `npm test`。";
    const masked = mask(source);
    const token = masked.slots[0]?.token ?? "";
    const numeric = token.replace(/[^\d]/g, "");
    const mangled = masked.masked.replace(token, `［ ［ ${numeric} ］ ］`);
    const restored = restore(mangled, masked.slots);
    assert.ok(restored.ok);
    assert.ok(restored.text.includes("`npm test`"));
  });

  it("reports a dropped placeholder instead of guessing", () => {
    const source = "运行 `npm test` 并报告结果。";
    const masked = mask(source);
    const translated = masked.masked.replace(/\[\[\d+\]\]/g, "");
    const restored = restore(translated, masked.slots);
    assert.equal(restored.ok, false);
    assert.equal(restored.missing.length, 1);
    assert.equal(restored.missing[0]?.original, "`npm test`");
  });

  it("reports duplicated and unknown placeholders", () => {
    const source = "运行 `npm test`。";
    const masked = mask(source);
    const token = masked.slots[0]?.token ?? "";

    const duplicated = restore(`${masked.masked} ${token}`, masked.slots);
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.duplicated.length, 1);

    const unknown = restore(`${masked.masked} [[99]]`, masked.slots);
    assert.equal(unknown.ok, false);
    assert.deepEqual(unknown.unknownIndices, [99]);
  });

  it("applies a glossary without translating the term", () => {
    const source = "解释泛型 (generics) 在 TypeScript 里的用法。";
    const masked = mask(source, { glossary: [{ source: "泛型", target: "generics" }] });
    assert.ok(masked.slots.some((slot) => slot.kind === "glossary"));
    const restored = restore(masked.masked, masked.slots);
    assert.ok(restored.text.includes("generics"));
    assert.equal(restored.ok, true);
  });

  it("keeps glossary replacement text when the term is restored", () => {
    const masked = mask("请用 TypeScript 实现。", { glossary: [{ source: "TypeScript", target: "TypeScript" }] });
    const restored = restore(masked.masked, masked.slots);
    assert.ok(restored.text.includes("TypeScript"));
  });

  it("can be turned off entirely", () => {
    const source = "运行 `npm test`。";
    const masked = mask(source, { preserveCode: false });
    assert.equal(masked.slots.length, 0);
    assert.equal(masked.masked, source);
  });
});

describe("language heuristics", () => {
  it("detects CJK", () => {
    assert.equal(hasCjk("请解释这段代码"), true);
    assert.equal(hasCjk("explain this code"), false);
  });

  it("recognises English input", () => {
    assert.equal(looksEnglish("Please refactor this function."), true);
    assert.equal(looksEnglish("请重构这个函数"), false);
    assert.equal(looksEnglish("请 refactor 这个"), false);
  });
});
