/**
 * Exercises the DSH plugin's real client.js against the real local engine.
 *
 * There is no React renderer here: a tiny hook stub keeps hook slots across
 * renders, `setDraft` re-renders the component the way the real store would,
 * and the button's onClick is invoked directly. That covers the parts that can
 * break — draft reading, segmentation, engine calls, submit ordering.
 *
 * Skipped when the engine is not listening.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_FILE = join(ROOT, "dsh-plugin", "linguabridge-send", "client.js");
const ENDPOINT = process.env["LB_ENDPOINT"] ?? "http://127.0.0.1:5000";

interface Element {
  type: string;
  props: Record<string, unknown>;
}

interface Harness {
  /** Render the component with a draft and a set of input actions. */
  render: (draft: string, actions: Record<string, unknown>) => Element;
  /** Point the plugin at another engine base URL. */
  setEndpoint: (value: string | null) => void;
  /** Fire a synthetic keydown at the most recently registered listener. */
  dispatchKeyDown: (event: Record<string, unknown>) => void;
}

function findButton(element: Element): Element | null {
  if (element.type === "button") return element;
  const children = (element.props["children"] ?? []) as unknown[];
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && typeof child === "object" && "type" in child) {
      const found = findButton(child as Element);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Depth-first search for an element carrying `className`. */
function findByClass(element: Element, className: string): Element | null {
  if (typeof element.props["className"] === "string" && (element.props["className"] as string).includes(className)) {
    return element;
  }
  const children = (element.props["children"] ?? []) as unknown[];
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && typeof child === "object" && "type" in child) {
      const found = findByClass(child as Element, className);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Depth-first search for the first element of a tag name. */
function findByType(element: Element, type: string): Element | null {
  if (element.type === type) return element;
  const children = (element.props["children"] ?? []) as unknown[];
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && typeof child === "object" && "type" in child) {
      const found = findByType(child as Element, type);
      if (found !== null) return found;
    }
  }
  return null;
}

async function createHarness(): Promise<Harness> {
  const source = await readFile(CLIENT_FILE, "utf8");
  let definition: { factory: (require: (id: string) => unknown) => Record<string, unknown> } | null = null;
  let endpointOverride: string | null = null;

  const hooks: unknown[] = [];
  let cursor = 0;
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...(props as Record<string, unknown> | null), children },
    }),
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [
        hooks[index],
        (next: unknown) => {
          hooks[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks[index]) : next;
        },
      ];
    },
    useCallback: (fn: unknown) => {
      const index = cursor++;
      hooks[index] = fn;
      return fn;
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect: (fn: unknown) => {
      const index = cursor++;
      hooks[index] = fn;
      // Run the effect immediately: the tests only need the listener it registers.
      (fn as () => void)();
    },
  };

  const keyDownListeners: Array<(event: unknown) => void> = [];
  const documentStub = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === "keydown") keyDownListeners.push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type !== "keydown") return;
      const index = keyDownListeners.indexOf(fn);
      if (index >= 0) keyDownListeners.splice(index, 1);
    },
  };

  const windowStub = {
    __ModuleLoader__: {
      load: (value: typeof definition) => {
        definition = value;
      },
    },
    localStorage: { getItem: () => endpointOverride },
  };

  const requireStub = (id: string): unknown => {
    if (id === "react") return React;
    throw new Error(`unexpected require: ${id}`);
  };

  // eslint-disable-next-line no-new-func
  const evaluate = new Function(
    "window",
    "document",
    "require",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "AbortController",
    source,
  );
  evaluate(windowStub, documentStub, requireStub, globalThis.fetch, setTimeout, clearTimeout, AbortController);

  assert.ok(definition !== null, "client.js must register a module factory");
  const module = (definition as { factory: (r: (id: string) => unknown) => Record<string, unknown> }).factory(
    requireStub,
  );

  let registered: { component: (props: Record<string, unknown>) => Element } | null = null;
  const slots = {
    inject: (_key: string, callback: () => unknown) => callback(),
    register: (_options: unknown, component: never) => {
      registered = { component };
    },
  };
  (module["apply"] as (ctx: unknown) => void)({ slots });
  assert.ok(registered !== null, "apply() must register the composer entry");

  const component = (registered as { component: (props: Record<string, unknown>) => Element }).component;

  return {
    render(draft, actions) {
      cursor = 0;
      return component({ useInput: (selector: (value: unknown) => unknown) => selector({ draft }), inputActions: actions });
    },
    setEndpoint(value) {
      endpointOverride = value;
    },
    dispatchKeyDown(event) {
      const listener = keyDownListeners[keyDownListeners.length - 1];
      if (listener !== undefined) listener(event);
    },
  };
}

async function engineUp(): Promise<boolean> {
  try {
    const response = await fetch(`${ENDPOINT}/health`);
    if (!response.ok) return false;
    const payload = (await response.json()) as { status?: string };
    return payload.status === "ok";
  } catch {
    return false;
  }
}

const ZH_DRAFT = [
  "必须保留下面代码的缩进，不要改写实现。",
  "```ts",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "```",
  "完成后把结果写到 C:\\work\\report.md。",
].join("\n");

describe("dsh plugin · 译并发送", () => {
  it("translates the draft, writes it back and submits", async (t) => {
    if (!(await engineUp())) {
      t.skip(`no engine on ${ENDPOINT}`);
      return;
    }

    const harness = await createHarness();
    let submittedDraft = "";
    let submitted = false;
    let draftState = ZH_DRAFT;

    const actions: Record<string, unknown> = {
      setDraft: (text: string) => {
        submittedDraft = text;
        draftState = text;
        // The real store publishes a new snapshot and re-renders the entry.
        harness.render(draftState, actions);
      },
      persistDraft: () => {},
      submit: () => {
        submitted = true;
      },
    };

    const tree = harness.render(draftState, actions);
    const button = findButton(tree);
    assert.ok(button !== null, "the entry must render a button");
    assert.equal(button?.props["aria-label"], "翻译并发送");

    (button?.props["onClick"] as () => void)();

    // Idle: the loader sits beside the button, turning, and is not sweeping.
    const idleLoader = findByClass(tree, "lb-loader-inline");
    assert.ok(idleLoader !== null, "the loader must always be rendered, not only while busy");
    const idleClass = String(idleLoader?.props["className"]);
    assert.ok(!idleClass.includes("paused"), "the animation must keep running regardless of position");
    assert.ok(!idleClass.includes("lb-sweep"), "the idle loader must not be sweeping");
    const travelVar = (idleLoader?.props["style"] as Record<string, unknown>)["--lb-travel"];
    assert.ok(String(travelVar).startsWith("-"), "the sweep distance must be a negative offset");

    (button?.props["onClick"] as () => void)();

    // Busy: the sweep animation starts from that offset and runs 6s to the right.
    const busyTree = harness.render(draftState, actions);
    const busyLoader = findByClass(busyTree, "lb-loader-inline");
    assert.ok(busyLoader !== null, "the loader must still be mounted after the click");
    assert.ok(
      String(busyLoader?.props["className"]).includes("lb-sweep"),
      "the busy loader must run the sweep animation",
    );
    assert.equal(
      (busyLoader?.props["style"] as Record<string, unknown>)["--lb-travel"],
      travelVar,
      "the sweep must start from the measured offset",
    );
    assert.ok(findByClass(busyTree, "lb-loader") !== null, "the animation element must be rendered");

    const asElement = (value: unknown): Element | null =>
      value !== null && typeof value === "object" && "type" in (value as object) ? (value as Element) : null;
    const row = (busyTree.props["children"] ?? []) as unknown[];
    const loaderIndex = row.findIndex((child) => asElement(child)?.props["className"] === "lb-loader-track");
    const buttonIndex = row.findIndex((child) => asElement(child)?.type === "button");
    assert.ok(loaderIndex >= 0 && buttonIndex >= 0, "both the loader and the button must be in the row");
    assert.ok(loaderIndex < buttonIndex, "the loader must render to the left of the button");

    const styleElement = findByType(busyTree, "style");
    assert.ok(styleElement !== null, "the loader stylesheet must be inlined");
    const css = String((styleElement?.props["children"] as unknown[])[0] ?? "");
    assert.ok(css.includes("@keyframes lb-loader"), "loader keyframes must be present");
    assert.ok(!css.includes("position: fixed"), "the loader must be inline, not a floating overlay");
    assert.ok(css.includes("lb-loader 2s infinite"), "the animation must run continuously");
    assert.ok(css.includes("@keyframes lb-sweep"), "the travel must be a keyframe animation, not a transition");
    assert.ok(css.includes("lb-sweep 6s linear"), "the travel must take six seconds at constant speed");

    const deadline = Date.now() + 30_000;
    while (!submitted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(submitted, true, "submit() must be called after translation");
    assert.ok(submittedDraft.length > 0, "setDraft() must receive the translation");
    // Code block survives byte-for-byte.
    assert.ok(submittedDraft.includes("export function add(a: number, b: number): number {"));
    assert.ok(submittedDraft.includes("\n  return a + b;\n"));
    assert.ok(submittedDraft.includes("C:\\work\\report.md"));
    // The prose is English now, and the source Chinese is gone.
    assert.ok(!/[\u4e00-\u9fff]/.test(submittedDraft), `Chinese left in output: ${submittedDraft}`);
    assert.ok(/must|keep|preserve|retain/i.test(submittedDraft));

    console.log(`\n  [plugin zh->en] ${submittedDraft.replace(/\n/g, " ⏎ ")}`);
  });

  it("refuses to send when the engine is unreachable", async () => {
    const harness = await createHarness();
    let submitted = false;
    let draftWritten = false;
    const actions: Record<string, unknown> = {
      setDraft: () => {
        draftWritten = true;
      },
      persistDraft: () => {},
      submit: () => {
        submitted = true;
      },
    };

    harness.setEndpoint("http://127.0.0.1:5999");
    const tree = harness.render("帮我总结一下这段话。", actions);
    const button = findButton(tree);
    assert.ok(button !== null);
    (button?.props["onClick"] as () => void)();

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(submitted, false, "must not submit when translation failed");
    assert.equal(draftWritten, false, "must not overwrite the draft when translation failed");
  });

  it("refuses to send an empty draft", async () => {
    const harness = await createHarness();
    let submitted = false;
    const actions: Record<string, unknown> = {
      setDraft: () => {},
      persistDraft: () => {},
      submit: () => {
        submitted = true;
      },
    };

    const tree = harness.render("   ", actions);
    const button = findButton(tree);
    assert.ok(button !== null);
    (button?.props["onClick"] as () => void)();

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(submitted, false);
  });

  it("only the button triggers translation — Enter is never intercepted", async () => {
    const source = await readFile(CLIENT_FILE, "utf8");
    assert.ok(!source.includes("keydown"), "the plugin must not listen for keydown");
    assert.ok(!source.includes("'Enter'"), "Enter must stay entirely native");
    assert.ok(!source.includes("isComposing"), "no composition-aware key handling should exist");
  });
});
