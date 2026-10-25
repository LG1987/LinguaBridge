// Build the MV3 extension with esbuild.
//
// Two bundles are produced because they run in different worlds:
//   background.js — module service worker (host permissions, does the HTTP fetch to
//                   the local translation service so the page CSP never applies).
//   content.js    — IIFE injected into the page (site adapters + shadow-DOM panel).
import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
};

const bundles = [
  {
    ...shared,
    entryPoints: [join(root, "src/background/index.ts")],
    outfile: join(outDir, "background.js"),
    format: "esm",
  },
  {
    ...shared,
    entryPoints: [join(root, "src/content/index.ts")],
    outfile: join(outDir, "content.js"),
    format: "iife",
  },
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "src/manifest.json"), "utf8"));
  manifest.version = pkg.version;
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, "src/assets"), join(outDir, "assets"), { recursive: true }).catch(() => {});
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await Promise.all(bundles.map((b) => build(b)));
await copyStatic();

if (watch) {
  for (const b of bundles) {
    const ctx = await context(b);
    await ctx.watch();
  }
  console.log("watching for changes…");
}
