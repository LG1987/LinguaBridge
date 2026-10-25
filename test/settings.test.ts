import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  resetSettingsForTests,
  saveSettings,
  updateSettings,
} from "../src/core/settings.ts";

describe("settings", () => {
  beforeEach(() => {
    resetSettingsForTests();
  });

  it("falls back to the documented safety defaults", () => {
    const settings = normalizeSettings(undefined);
    assert.equal(settings.inputMode, "manual");
    assert.equal(settings.responseMode, "bilingual");
    assert.equal(settings.preserveCode, true);
    assert.equal(settings.saveHistory, false);
    assert.equal(settings.allowAutoSend, false);
    assert.equal(settings.localEndpoint, "http://127.0.0.1:5000");
    assert.equal(settings.timeoutMs, 15_000);
  });

  it("clamps and repairs nonsense values", () => {
    const settings = normalizeSettings({
      timeoutMs: 999_999,
      localEndpoint: " 127.0.0.1:5001/ ",
      chineseVariant: "klingon",
      inputMode: "auto",
      provider: "",
      glossary: [{ source: "  ", target: "x" }, { source: " API ", target: " API " }],
    });
    assert.equal(settings.timeoutMs, 60_000);
    assert.equal(settings.localEndpoint, "http://127.0.0.1:5001");
    assert.equal(settings.chineseVariant, DEFAULT_SETTINGS.chineseVariant);
    assert.equal(settings.inputMode, "auto");
    assert.equal(settings.provider, DEFAULT_SETTINGS.provider);
    assert.deepEqual(settings.glossary, [{ source: "API", target: "API" }]);
  });

  it("persists through the in-memory fallback without chrome APIs", async () => {
    const saved = await saveSettings({ ...DEFAULT_SETTINGS, sendTargetLanguage: "en", readingLanguage: "zh" });
    assert.equal(saved.readingLanguage, "zh");

    const updated = await updateSettings({ timeoutMs: 12_000 });
    assert.equal(updated.timeoutMs, 12_000);

    const loaded = await loadSettings();
    assert.equal(loaded.timeoutMs, 12_000);
  });

  it("keeps the manual-confirmation default when a stored object omits it", async () => {
    const loaded = await saveSettings({ ...DEFAULT_SETTINGS, inputMode: "manual" });
    assert.equal(loaded.inputMode, "manual");
    assert.equal(loaded.allowAutoSend, false);
  });
});
