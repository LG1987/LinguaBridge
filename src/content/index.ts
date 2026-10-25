/**
 * Content-script controller.
 *
 * Responsibilities, in order of importance:
 *   1. never touch the editor while an IME composition is running;
 *   2. show the source and the translation side by side and let the human decide;
 *   3. insert reply translations as separate cards, never into the original DOM.
 */

import { sendRuntimeMessage, type HealthReply, type PingReply, type TranslateReply } from "../core/messaging.ts";
import { loadSettings, type LinguaBridgeSettings } from "../core/settings.ts";
import { imeGuard } from "./ime.ts";
import { selectedText } from "./text.ts";
import { ComparePanel, createLauncher, createReplyCard } from "./ui/panel.ts";
import { ChatGptAdapter } from "./sites/chatgpt.ts";
import { DshAdapter } from "./sites/dsh.ts";
import type { ResponseTarget, SiteAdapter } from "./sites/types.ts";

type Mode = "prompt" | "selection";

const START_HINT =
  "启动方法：在项目目录运行 tools\\start-engine.ps1（或 libretranslate --host 127.0.0.1 --port 5000 --load-only en,zh）。";

let settings: LinguaBridgeSettings;
let adapter: SiteAdapter | null = null;
let panel: ComparePanel;
let launcher: HTMLElement | null = null;
let lastWrittenText = "";
let currentSource = { text: "", mode: "prompt" as Mode };
/** Shown in the panel so a bug report names the build that produced it. */
let extensionVersion = "";

const translatedReplyKeys = new Set<string>();
const replyCards = new Map<string, HTMLElement>();
let settleTimer: number | undefined;
let stopObserving: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMostlyCjk(text: string): boolean {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk > letters;
}

function failureHint(reply: { kind: string; message: string }): string {
  if (reply.kind === "unreachable" || reply.kind === "timeout") {
    return `${reply.message}\n${START_HINT}`;
  }
  if (reply.kind === "format-integrity") {
    return `${reply.message}\n说明：译文里缺少受保护的代码/链接片段，为避免破坏提示词已拒绝写入。`;
  }
  return reply.message;
}

async function showFailure(message: string, sourceText: string): Promise<void> {
  panel.render({ source: sourceText, translation: "", warnings: [], error: message });
}

async function translateText(text: string, mode: Mode): Promise<void> {
  if (!imeGuard.isSafe()) {
    panel.render({
      source: text,
      translation: "",
      warnings: [],
      error: "输入法正在组合中，已暂停翻译。请先完成本次输入（按空格/回车确认候选词）再试。",
    });
    return;
  }
  if (text.trim() === "") {
    panel.render({ source: "", translation: "", warnings: [], error: "输入框是空的，先写点内容再翻译。" });
    return;
  }

  currentSource = { text, mode };
  panel.render({ source: text, translation: "", warnings: [], busy: true });

  try {
    const reply = await sendRuntimeMessage<TranslateReply>({
      type: "lb:translate",
      request: {
        text,
        sourceLanguage: "auto",
        targetLanguage: settings.sendTargetLanguage,
        mode: mode === "prompt" ? "prompt" : "plain",
      },
    });

    if (!reply.ok) {
      await showFailure(failureHint(reply), text);
      return;
    }

    const meta = [
      reply.providerId,
      `${(reply.latencyMs / 1000).toFixed(1)}s`,
      reply.restoredSlots > 0 ? `已还原 ${reply.restoredSlots} 处代码/链接` : "无受保护格式",
      reply.detectedSourceLanguage !== undefined ? `检测语言 ${reply.detectedSourceLanguage}` : "",
      extensionVersion !== "" ? `v${extensionVersion}` : "",
    ]
      .filter((part) => part !== "")
      .join(" · ");

    panel.render({
      source: text,
      translation: reply.translatedText,
      warnings: reply.warnings,
      meta,
      busy: false,
    });
  } catch (error) {
    await showFailure(error instanceof Error ? error.message : String(error), text);
  }
}

async function translatePrompt(): Promise<void> {
  if (adapter === null) return;
  if (!imeGuard.isSafe()) {
    panel.render({
      source: adapter.readInput(),
      translation: "",
      warnings: [],
      error: "输入法正在组合中，暂时不能操作输入框。",
    });
    return;
  }
  const text = adapter.readInput();
  await translateText(text, "prompt");
}

async function translateSelection(): Promise<void> {
  const text = selectedText();
  if (text === "") {
    panel.render({ source: "", translation: "", warnings: [], error: "没有选中文本。先选中一段内容再点右键菜单。" });
    return;
  }
  await translateText(text, "selection");
}

function writeToInput(text: string): boolean {
  if (adapter === null) return false;
  if (!imeGuard.isSafe()) {
    panel.setOutcome("输入法正在组合中，未写入。请完成输入后再试。", "error");
    return false;
  }
  const result = adapter.writeInput(text);
  if (!result.ok) {
    panel.setOutcome(`${result.reason ?? "写入失败（页面没有接受文本）。"}`, "error");
    return false;
  }
  lastWrittenText = text;
  return true;
}

function wirePanel(): void {
  panel = new ComparePanel({
    onRetranslate: () => {
      void translateText(currentSource.text, currentSource.mode);
    },
    onWrite: (text) => {
      if (writeToInput(text)) {
        panel.setOutcome("已写入输入框。请核对后按 Enter 发送（本扩展不会自动发送）。", "ok");
      }
    },
    onWriteAndSend: (text) => {
      if (!writeToInput(text)) return;
      const sent = adapter?.send() ?? false;
      panel.setOutcome(sent ? "已写入并触发发送。" : "已写入，但没有找到发送按钮，请手动按 Enter。", sent ? "ok" : "error");
      if (sent) {
        window.setTimeout(() => panel.close(), 700);
      }
    },
    onClose: () => panel.close(),
  });
}

/** Wait for the SPA to render the composer before deciding this page is unsupported. */
async function waitForAdapter(timeoutMs = 20_000): Promise<SiteAdapter | null> {
  const candidates: SiteAdapter[] = [new DshAdapter(), new ChatGptAdapter()];
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    for (const candidate of candidates) {
      try {
        if (candidate.match(new URL(location.href))) return candidate;
      } catch {
        /* url parse failure: keep waiting */
      }
    }
    await sleep(400);
  }
  return null;
}

let lastTriggerAt = Number.NEGATIVE_INFINITY;

/**
 * Both the in-page shortcut and `chrome.commands` can fire for Ctrl+Alt+T.
 * Collapse the pair into one translation.
 */
function triggerPrompt(): void {
  const now = performance.now();
  if (now - lastTriggerAt < 400) return;
  lastTriggerAt = now;
  void translatePrompt();
}

function replyKeyIsFresh(target: ResponseTarget): boolean {
  if (translatedReplyKeys.has(target.key)) return false;
  if (lastWrittenText !== "" && target.text.trim() === lastWrittenText.trim()) return false; // echo of our own prompt
  // The user's draft can look like the newest transcript row on some layouts.
  const draft = adapter?.readInput() ?? "";
  if (draft !== "" && target.text.trim() === draft.trim()) return false;
  if (settings.readingLanguage.startsWith("zh") && isMostlyCjk(target.text)) return false; // already Chinese
  if (target.text.trim().length < 8) return false;
  return true;
}

async function translateReply(target: ResponseTarget): Promise<void> {
  try {
    const reply = await sendRuntimeMessage<TranslateReply>({
      type: "lb:translate",
      request: {
        text: target.text,
        sourceLanguage: "auto",
        targetLanguage: settings.readingLanguage,
        mode: "response",
      },
    });
    if (!reply.ok || reply.skipped) return;
    if (reply.translatedText.trim() === target.text.trim()) return;

    const meta = `${(reply.latencyMs / 1000).toFixed(1)}s · ${reply.providerId}`;
    const existing = replyCards.get(target.key);
    if (existing !== undefined && existing.isConnected) {
      // Streaming reply: replace the card body instead of stacking new cards.
      const replacement = createReplyCard({
        translatedText: reply.translatedText,
        meta,
        warnings: reply.warnings,
      });
      existing.replaceWith(replacement);
      replyCards.set(target.key, replacement);
      return;
    }

    const card = createReplyCard({ translatedText: reply.translatedText, meta, warnings: reply.warnings });
    adapter?.insertResponseCard(target, card);
    replyCards.set(target.key, card);
    translatedReplyKeys.add(target.key);
  } catch {
    // Reply translation is best-effort: a failure must not disturb the page.
  }
}

async function checkLatestReply(): Promise<void> {
  if (adapter === null || settings.responseMode === "off" || !settings.autoTranslateResponse) return;
  if (!imeGuard.isSafe()) {
    scheduleReplyCheck(1_500);
    return;
  }
  const target = adapter.getLatestResponse();
  if (target === null || !replyKeyIsFresh(target)) return;

  // Only translate a reply that stopped changing (streaming produces many edits).
  const snapshot = replySnapshots.get(target.key);
  if (snapshot !== target.text) {
    replySnapshots.set(target.key, target.text);
    scheduleReplyCheck(1_400);
    return;
  }
  await translateReply(target);
}

const replySnapshots = new Map<string, string>();

function scheduleReplyCheck(delayMs = 1_400): void {
  if (settleTimer !== undefined) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = undefined;
    void checkLatestReply();
  }, delayMs);
}

function isTypingShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (event.ctrlKey || event.metaKey) && event.altKey && (key === "t" || key === "l");
}

function registerShortcuts(): void {
  // In-page shortcut (chrome.commands only fires when the browser window is focused).
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isTypingShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      triggerPrompt();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message: { type?: string; command?: string }) => {
    if (message.type !== "lb:command") return;
    if (message.command === "translate-prompt") triggerPrompt();
    if (message.command === "translate-selection") void translateSelection();
  });
}

async function bootstrap(): Promise<void> {
  if (document.documentElement.dataset["linguabridge"] === "1") return;
  document.documentElement.dataset["linguabridge"] = "1";

  imeGuard.attach();
  settings = await loadSettings();
  wirePanel();
  registerShortcuts();

  adapter = await waitForAdapter();
  if (adapter === null) return;

  launcher = createLauncher(() => {
    triggerPrompt();
  });
  document.documentElement.append(launcher);

  if (settings.autoTranslateResponse && settings.responseMode !== "off") {
    stopObserving = adapter.observeResponses(() => scheduleReplyCheck(1_200));
    // A transcript that was already on screen when the tab opened produces no
    // mutation, so translate the latest reply once after the page settles.
    scheduleReplyCheck(1_800);
  }

  // Surface a broken local service early instead of only on the first attempt.
  try {
    const health = await sendRuntimeMessage<HealthReply>({ type: "lb:health" });
    if (!health.healthy) {
      launcher.title = `LinguaBridge：连不上 ${health.endpoint}（点「译」查看指引）`;
    }
  } catch {
    /* worker not ready yet — the first translate attempt will report it */
  }

  try {
    const ping = await sendRuntimeMessage<PingReply>({ type: "lb:ping" });
    extensionVersion = ping.version;
  } catch {
    /* version is cosmetic */
  }

  window.addEventListener("pagehide", () => {
    stopObserving?.();
  });
}

void bootstrap().catch((error: unknown) => {
  // Never break the host page: log once and stay silent.
  console.warn("[LinguaBridge] bootstrap failed:", error instanceof Error ? error.message : error);
});
