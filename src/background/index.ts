/**
 * Service worker: the only place that talks HTTP to the local engine.
 *
 * It owns the host permissions, so page CSP / CORS / mixed-content rules never
 * apply. It also never logs prompt or reply text — the plan forbids persisting
 * conversation content.
 */

import { runPipeline, FormatIntegrityError } from "../core/pipeline.ts";
import { LibreTranslateProvider } from "../core/provider.ts";
import type { HealthReply, RuntimeMessage, TranslateFail, TranslateReply } from "../core/messaging.ts";
import { loadSettings } from "../core/settings.ts";
import { TranslationError } from "../core/types.ts";

const CONTEXT_MENU_ID = "lb-translate-selection";

function providerFor(settings: Awaited<ReturnType<typeof loadSettings>>): LibreTranslateProvider {
  return new LibreTranslateProvider({
    endpoint: settings.localEndpoint,
    timeoutMs: settings.timeoutMs,
  });
}

async function handleTranslate(message: Extract<RuntimeMessage, { type: "lb:translate" }>): Promise<TranslateReply> {
  const settings = await loadSettings();
  const provider = providerFor(settings);
  try {
    const outcome = await runPipeline({
      text: message.request.text,
      provider,
      targetLanguage: message.request.targetLanguage || settings.sendTargetLanguage,
      sourceLanguage: message.request.sourceLanguage,
      mode: message.request.mode,
      preserveCode: settings.preserveCode,
      glossary: message.glossary ?? settings.glossary,
      chineseVariant: settings.chineseVariant,
    });

    return {
      ok: true,
      translatedText: outcome.translatedText,
      providerId: outcome.providerId,
      latencyMs: outcome.latencyMs,
      warnings: outcome.warnings,
      ...(outcome.detectedSourceLanguage !== undefined
        ? { detectedSourceLanguage: outcome.detectedSourceLanguage }
        : {}),
      restoredSlots: outcome.restoredSlots,
      skipped: outcome.skipped,
    };
  } catch (error) {
    if (error instanceof FormatIntegrityError) {
      const failure: TranslateFail = {
        ok: false,
        kind: "format-integrity",
        message: error.message,
        invalidSlots: error.invalidSlots,
      };
      return failure;
    }
    if (error instanceof TranslationError) {
      return { ok: false, kind: error.kind, message: error.userMessage };
    }
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: "unknown", message: `翻译失败：${text}` };
  }
}

async function handleHealth(): Promise<HealthReply> {
  const settings = await loadSettings();
  const health = await providerFor(settings).health();
  return {
    ok: true,
    healthy: health.ok,
    endpoint: health.endpoint,
    latencyMs: health.latencyMs,
    hasChineseEnglishPair: health.hasChineseEnglishPair,
    languages: health.languages.map((language) => language.code),
    ...(health.message !== undefined ? { message: health.message } : {}),
  };
}

async function refreshBadge(): Promise<void> {
  const health = await handleHealth();
  const text = health.healthy ? "✓" : "!";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: health.healthy ? "#2f7d32" : "#b23a2f" });
  await chrome.action.setTitle({
    title: health.healthy
      ? `LinguaBridge 已连接 ${health.endpoint}（${health.latencyMs}ms）`
      : `LinguaBridge：连不上 ${health.endpoint}`,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "用 LinguaBridge 翻译选中文本（本地）",
    contexts: ["selection"],
  });
  void refreshBadge();
});

chrome.runtime.onStartup?.addListener(() => {
  void refreshBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || tab?.id === undefined) return;
  void chrome.tabs.sendMessage(tab.id, { type: "lb:command", command: "translate-selection" }).catch(() => {
    // No content script on this tab (unsupported site) — nothing to do.
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "translate-prompt") return;
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (tab?.id !== undefined) {
        return chrome.tabs.sendMessage(tab.id, { type: "lb:command", command: "translate-prompt" });
      }
      return undefined;
    })
    .catch(() => undefined);
});

chrome.action.onClicked.addListener(() => {
  void refreshBadge();
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  void (async () => {
    switch (message.type) {
      case "lb:translate":
        sendResponse(await handleTranslate(message));
        break;
      case "lb:health":
        sendResponse(await handleHealth());
        break;
      case "lb:ping":
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
        break;
      case "lb:command":
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, kind: "unknown", message: "未知消息类型。" });
    }
  })();
  return true; // keep the channel open for the async response
});
