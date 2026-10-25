/**
 * DOM-level tests for the site adapters.
 *
 * jsdom cannot run Lexical, so these tests verify the parts that are ours:
 * anchor discovery, transcript extraction (tool calls/buttons excluded), card
 * insertion, write-then-verify, IME gating and send-button wiring.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));

const DSH_HTML = `<!doctype html><html><body>
  <div data-conversation-scroll style="height:600px;overflow:auto">
    <div data-chat-anchor-key="k1" data-chat-node-key="n1" data-chat-turn="1">
      <div data-slot="conversation.chat.user.content"><div>请解释 TypeScript 泛型</div></div>
    </div>
    <div data-chat-anchor-key="k1b" data-chat-node-key="n1b" data-chat-turn="1" data-submission-echo="">
      <div>请解释 TypeScript 泛型</div>
    </div>
    <div data-chat-anchor-key="k2" data-chat-node-key="n2" data-chat-flow-kind="turn-process" data-chat-turn="2">
      <div data-chat-call-id="call-1"><div>{"tool":"read_file","path":"C:\\\\x.ts"}</div></div>
    </div>
    <div data-chat-anchor-key="k3" data-chat-node-key="n3" data-chat-turn="2">
      <div class="haSm5q_markdown">
        <h2>泛型</h2>
        <p>泛型允许在编译期保留类型信息。</p>
        <pre><code>function id&lt;T&gt;(x: T): T { return x; }</code></pre>
      </div>
      <div data-slot="conversation.chat.reasoning.content"><p>这里是想过程，不应该被翻译</p></div>
      <button>复制</button>
    </div>
    <div data-chat-anchor-key="k4" data-chat-node-key="n4" data-chat-flow-kind="turn-tail" data-turn-tail="2" data-chat-turn="2">
      <div data-slot="conversation.chat.assistant-actions"><button>重新生成</button></div>
      <span>1.2k tokens</span>
    </div>
    <div data-composer-seat>
      <div data-composer-card>
        <div contenteditable="true" data-lexical-editor="true">请帮我写一个函数</div>
        <button type="submit" aria-label="发送">↑</button>
      </div>
    </div>
  </div>
</body></html>`;

const CHATGPT_HTML = `<!doctype html><html><body>
  <main>
    <article data-testid="conversation-turn-1">
      <div data-message-author-role="user"><p>Explain closures.</p></div>
    </article>
    <article data-testid="conversation-turn-2">
      <div data-message-author-role="assistant" data-message-id="m-2">
        <p>A closure captures its lexical scope.</p>
        <pre><code>const f = () =&gt; x;</code></pre>
      </div>
      <button aria-label="Copy">Copy</button>
    </article>
    <form>
      <textarea id="prompt-textarea"></textarea>
      <button data-testid="send-button">Send</button>
    </form>
  </main>
</body></html>`;

function installDom(html: string, url: string): JSDOM {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  // jsdom reports zero-size rects, which our visibility check treats as hidden.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, width: 320, height: 24, top: 0, left: 0, right: 320, bottom: 24, toJSON: () => ({}) };
  } as typeof window.Element.prototype.getBoundingClientRect;

  const globals = globalThis as Record<string, unknown>;
  const setGlobal = (key: string, value: unknown): void => {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
      globals[key] = value;
    }
  };
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("HTMLElement", window.HTMLElement);
  setGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  setGlobal("HTMLInputElement", window.HTMLInputElement);
  setGlobal("Element", window.Element);
  setGlobal("Node", window.Node);
  setGlobal("InputEvent", window.InputEvent);
  setGlobal("Event", window.Event);
  setGlobal("CompositionEvent", window.CompositionEvent);
  setGlobal("KeyboardEvent", window.KeyboardEvent);
  setGlobal("MutationObserver", window.MutationObserver);
  setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  setGlobal("navigator", window.navigator);
  return dom;
}

const { DshAdapter } = await import("../src/content/sites/dsh.ts");
const { ChatGptAdapter } = await import("../src/content/sites/chatgpt.ts");
const { elementToText } = await import("../src/content/text.ts");
const { ImeGuard } = await import("../src/content/ime.ts");

describe("DSH adapter", () => {
  let adapter: InstanceType<typeof DshAdapter>;

  before(() => {
    installDom(DSH_HTML, "http://127.0.0.1:52252/");
    adapter = new DshAdapter();
  });

  it("detects the page by DOM markers, not by port", () => {
    assert.equal(adapter.match(new URL("http://127.0.0.1:52252/")), true);
    assert.equal(adapter.match(new URL("http://127.0.0.1:3080/")), true);
  });

  it("finds the Lexical composer and reads its draft", () => {
    const input = adapter.getInputElement();
    assert.ok(input !== null);
    assert.equal(input?.getAttribute("data-lexical-editor"), "true");
    assert.equal(adapter.readInput(), "请帮我写一个函数");
  });

  it("extracts the latest reply without tool calls, thinking, metadata or buttons", () => {
    const target = adapter.getLatestResponse();
    assert.ok(target !== null);
    assert.equal(target?.key, "node:n3");
    assert.ok(target?.text.includes("泛型允许在编译期保留类型信息。"));
    assert.ok(target?.text.includes("function id<T>(x: T): T { return x; }"));
    assert.ok(!target?.text.includes("复制"), "copy button must be excluded");
    assert.ok(!target?.text.includes("重新生成"), "action bar must be excluded");
    assert.ok(!target?.text.includes("read_file"), "tool-call payload must be excluded");
    assert.ok(!target?.text.includes("想过程"), "reasoning trace must be excluded");
    assert.ok(!target?.text.includes("tokens"), "turn-tail metadata row must be excluded");
    assert.ok(!target?.text.includes("请解释"), "user turn must not be picked");
  });

  it("inserts the translation card after the row, leaving the original intact", () => {
    const target = adapter.getLatestResponse();
    assert.ok(target !== null);
    const card = document.createElement("div");
    card.textContent = "双语卡片";
    adapter.insertResponseCard(target!, card);

    assert.equal(target?.anchor.nextElementSibling, card);
    assert.ok(target?.anchor.textContent?.includes("泛型允许"), "original message untouched");
  });

  it("writes and verifies text through the DOM fallback in jsdom", () => {
    const result = adapter.writeInput("Please write a function.");
    assert.equal(result.ok, true);
    assert.equal(adapter.readInput(), "Please write a function.");
  });

  it("clicks the site's own send button", () => {
    const button = document.querySelector('button[type="submit"]');
    let clicked = false;
    button?.addEventListener("click", () => {
      clicked = true;
    });
    assert.equal(adapter.send(), true);
    assert.equal(clicked, true);
  });

  it("does not claim a site match on a page without markers", () => {
    const bare = installDom("<html><body><p>hello</p></body></html>", "http://127.0.0.1:52252/");
    assert.equal(new DshAdapter().match(new URL("http://127.0.0.1:52252/")), false);
    bare.window.close();
  });
});

describe("ChatGPT adapter", () => {
  let adapter: InstanceType<typeof ChatGptAdapter>;

  before(() => {
    installDom(CHATGPT_HTML, "https://chatgpt.com/c/123");
    adapter = new ChatGptAdapter();
  });

  it("matches only the ChatGPT hosts", () => {
    assert.equal(adapter.match(new URL("https://chatgpt.com/c/123")), true);
    assert.equal(adapter.match(new URL("https://chat.openai.com/c/123")), true);
    assert.equal(adapter.match(new URL("http://127.0.0.1:52252/")), false);
  });

  it("reads the textarea composer and extracts the assistant turn", () => {
    const input = adapter.getInputElement();
    assert.ok(input instanceof HTMLTextAreaElement);
    assert.equal(adapter.readInput(), "");

    const target = adapter.getLatestResponse();
    assert.ok(target !== null);
    assert.equal(target?.key, "m-2");
    assert.ok(target?.text.includes("A closure captures its lexical scope."));
    assert.ok(target?.text.includes("const f = () => x;"));
    assert.ok(!target?.text.includes("Copy"));
  });

  it("writes into the textarea through the native setter", () => {
    const result = adapter.writeInput("请解释闭包。");
    assert.equal(result.ok, true);
    assert.equal(result.method, "nativeSetter");
    assert.equal(adapter.readInput(), "请解释闭包。");
  });

  it("inserts the card after the whole article", () => {
    const target = adapter.getLatestResponse();
    const card = document.createElement("div");
    adapter.insertResponseCard(target!, card);
    const article = target!.anchor.closest("article");
    assert.equal(article?.nextElementSibling, card);
  });
});

describe("mock UI fixture", () => {
  it("drives the real adapter against the browser test page", async () => {
    const html = await readFile(join(HERE, "fixtures", "dsh-mock.html"), "utf8");
    installDom(html, "http://127.0.0.1:8765/dsh-mock.html");
    const adapter = new DshAdapter();

    assert.equal(adapter.match(new URL("http://127.0.0.1:8765/dsh-mock.html")), true);

    const target = adapter.getLatestResponse();
    assert.ok(target !== null, "fixture must expose a reply row");
    assert.ok(target?.text.includes("The extension should translate this English reply"));
    assert.ok(target?.text.includes("const answer = 42;"));
    assert.ok(!target?.text.includes("用户消息"), "the user row must not be treated as a reply");
    assert.ok(!target?.text.includes("tokens"), "the turn-tail row must be ignored");

    const input = adapter.getInputElement();
    assert.ok(input !== null);
    const written = adapter.writeInput("把这段英文翻译成中文");
    assert.equal(written.ok, true);
    assert.equal(adapter.readInput(), "把这段英文翻译成中文");
  });
});

describe("IME guard", () => {
  beforeEach(() => {
    installDom("<html><body><div contenteditable='true'></div></body></html>", "http://127.0.0.1:52252/");
  });

  it("blocks reads and writes during composition, then releases", async () => {
    const guard = new ImeGuard(document).attach();
    assert.equal(guard.isSafe(), true);

    document.dispatchEvent(new window.CompositionEvent("compositionstart"));
    assert.equal(guard.isSafe(), false);

    document.dispatchEvent(new window.CompositionEvent("compositionend"));
    // Still inside the cooldown window right after the commit.
    assert.equal(guard.isSafe(), false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(guard.isSafe(), true);
  });
});

describe("text extraction", () => {
  before(() => {
    installDom(DSH_HTML, "http://127.0.0.1:52252/");
  });

  it("keeps block boundaries and code newlines", () => {
    const row = document.querySelector('[data-chat-node-key="n3"]');
    assert.ok(row !== null);
    const text = elementToText(row!);
    assert.ok(text.includes("泛型\n"));
    assert.ok(text.includes("function id<T>(x: T): T { return x; }"));
  });

  it("skips our own inserted cards", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>before</p><div data-linguabridge='reply'><div>译文卡片</div></div><p>after</p>";
    const text = elementToText(container);
    assert.ok(text.includes("before"));
    assert.ok(text.includes("after"));
    assert.ok(!text.includes("译文卡片"));
  });
});
