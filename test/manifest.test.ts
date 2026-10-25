/**
 * Manifest posture test.
 *
 * The extension's permissions and match patterns are part of its security
 * promise ("只申请实际需要的 host"), so they are asserted here instead of
 * relying on review. Runs without a build: dist/ existence only tightens the
 * check when present.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

interface Manifest {
  manifest_version: number;
  name: string;
  version: string;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: string };
  content_scripts: Array<{ matches: string[]; js: string[]; run_at: string }>;
  commands: Record<string, unknown>;
}

async function loadManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(ROOT, "src", "manifest.json"), "utf8")) as Manifest;
}

describe("manifest", () => {
  it("is MV3 with a module service worker", async () => {
    const manifest = await loadManifest();
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, "background.js");
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.content_scripts.length, 1);
    assert.deepEqual(manifest.content_scripts[0]?.js, ["content.js"]);
  });

  it("keeps the permission set minimal", async () => {
    const manifest = await loadManifest();
    assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "contextMenus", "storage"]);
    assert.ok(!manifest.permissions.includes("tabs"));
    assert.ok(!manifest.permissions.includes("scripting"));
  });

  it("never asks for all-site host access", async () => {
    const manifest = await loadManifest();
    for (const host of manifest.host_permissions) {
      assert.ok(host !== "<all_urls>", "must not request <all_urls>");
      assert.ok(!host.includes("*://"), `unexpected wildcard scheme in ${host}`);
    }
    assert.deepEqual([...manifest.host_permissions].sort(), [
      "http://127.0.0.1/*",
      "http://localhost/*",
      "https://chat.openai.com/*",
      "https://chatgpt.com/*",
    ]);
  });

  it("injects only on the loopback UI and ChatGPT, and only at document_idle", async () => {
    const manifest = await loadManifest();
    const script = manifest.content_scripts[0];
    assert.deepEqual([...(script?.matches ?? [])].sort(), [
      "http://127.0.0.1/*",
      "http://localhost/*",
      "https://chat.openai.com/*",
      "https://chatgpt.com/*",
    ]);
    assert.equal(script?.run_at, "document_idle");
  });

  it("declares the translate shortcut", async () => {
    const manifest = await loadManifest();
    assert.ok("translate-prompt" in manifest.commands);
  });

  it("matches the package version and the built dist when present", async () => {
    const manifest = await loadManifest();
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(manifest.version, "0.0.0", "source manifest keeps a placeholder version");

    const distManifest = join(ROOT, "dist", "manifest.json");
    if (!existsSync(distManifest)) return;
    const built = JSON.parse(await readFile(distManifest, "utf8")) as Manifest;
    assert.equal(built.version, pkg.version, "build must stamp package.json's version");
    for (const file of [built.background.service_worker, ...(built.content_scripts[0]?.js ?? [])]) {
      assert.ok(existsSync(join(ROOT, "dist", file)), `dist is missing ${file}`);
    }
  });
});
