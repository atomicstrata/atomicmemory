/**
 * @file Dist-contract tests: verify the built @atomicmemory/llmwiki/register
 * artifact meets its published contracts:
 *
 *   1. dist/register.d.ts references no heavy/live types.
 *   2. dist/register.js contains no static live-provider or compiler imports.
 *   3. The packed tarball ships both register subpath targets.
 *   4. The exports map resolves @atomicmemory/llmwiki/register (Node self-ref).
 *   5. Missing-peer subprocess: with llm-wiki-compiler made unresolvable,
 *      importing the shipped register artifact and constructing MemoryClient
 *      stay LIGHT; only initialize() surfaces E_LLMWIKI_COMPILER_MISSING.
 *
 * The `before()` hook runs `pnpm build` to ensure all assertions target a
 * freshly-built artifact. The missing-peer test lives in THIS file (not its
 * own) deliberately: it reads dist/register.js, and node:test runs separate
 * test FILES concurrently — a standalone file would race this file's build
 * (and a second build in its own before() would mean two concurrent tsc
 * writes into the same dist/, also a race). Within one file, tests run
 * sequentially after the single before(), so the dist is guaranteed fresh.
 *
 * NOTE: The `.d.ts` scan strips `/** ... * /` block comments before testing
 * for banned strings, so JSDoc prose mentioning "live provider" or the
 * compiler name in a description does not cause false positives.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// __tests__/ → src/ → llmwiki/
const PKG = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// Explicit headroom for a cold-cache CI tsc run (default test timeout is tighter).
before(() => {
  execFileSync("pnpm", ["build"], { cwd: PKG, stdio: "inherit" });
}, { timeout: 120_000 });

/** Strip block comments from a string to avoid false positives in prose. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Slices the JSON array out of npm pack --json output (may include progress lines). */
function extractJsonArray(output: string): string {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end < start) throw new Error("missing JSON array in npm pack output");
  return output.slice(start, end + 1);
}

test("dist/register.d.ts references no heavy/live types", () => {
  const raw = readFileSync(path.join(PKG, "dist/register.d.ts"), "utf-8");
  const dts = stripBlockComments(raw);
  for (const bad of ["./live", "LiveLLMWikiProvider", "llm-wiki-compiler"]) {
    assert.equal(dts.includes(bad), false, `dist/register.d.ts must not reference ${bad}`);
  }
});

test("dist/register.js (the shipped runtime) stays light: no static ./live or compiler import", () => {
  const js = readFileSync(path.join(PKG, "dist/register.js"), "utf-8");
  assert.equal(/from\s+["']\.\/live\//.test(js), false, "dist/register.js must not statically import ./live");
  assert.equal(/from\s+["']llm-wiki-compiler["']/.test(js), false, "dist/register.js must not import llm-wiki-compiler");
  assert.ok(/import\(\s*["']\.\/live\/provider\.js["']\s*\)/.test(js), "the dynamic import of ./live/provider.js must survive the build");
});

test("the packed tarball ships the register subpath targets", () => {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PKG,
    encoding: "utf-8",
  });
  const packed = JSON.parse(extractJsonArray(stdout));
  const files = packed[0].files.map((f: { path: string }) => f.path);
  for (const f of ["dist/register.js", "dist/register.d.ts"]) {
    assert.ok(files.includes(f), `tarball missing ${f}`);
  }
});

test("the built exports map resolves @atomicmemory/llmwiki/register (Node self-reference)", () => {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m = await import('@atomicmemory/llmwiki/register'); if (typeof m.liveLlmwikiLazyEntry !== 'function') { console.error('missing export'); process.exit(1); } console.log('OK');",
    ],
    { cwd: PKG, encoding: "utf-8" },
  );
  assert.match(out, /OK/);
});

// ---------------------------------------------------------------------------
// Missing-peer subprocess test
//
// Runs a child process where the deny-compiler.loader hook makes
// `llm-wiki-compiler` unresolvable, proving:
//   1. Importing @atomicmemory/llmwiki/register is LIGHT (no compiler load).
//   2. Constructing MemoryClient is LIGHT.
//   3. Only initialize() triggers the lazy compiler import — and it surfaces
//      the stable E_LLMWIKI_COMPILER_MISSING error code.
//
// Implementation notes:
//   - The subprocess script imports from `dist/register.js` (the built
//     output) rather than `src/register.ts`. This is necessary because on
//     Node 25 the `node:module` register() hook used by register-deny.mjs
//     interacts with tsx's ESM transform in a way that strips named exports
//     from TypeScript source files. Using the pre-built dist avoids the
//     conflict while still exercising the real shipped artifact (which is
//     why this test belongs in the dist-contract suite — and the shared
//     before() build above guarantees the dist is fresh, race-free).
//   - The script lives inside the package dir so `@atomicmemory/sdk` and
//     relative dist paths resolve via the package's node_modules.
//   - The deny hook (register-deny.mjs → deny-compiler.loader.mjs) uses
//     node:module's register() API to intercept llm-wiki-compiler resolution
//     before it reaches the default resolver.
// ---------------------------------------------------------------------------

const DENY_HOOK = path.join(PKG, "src/__tests__/fixtures/register-deny.mjs");
const SCRIPT_PATH = path.join(PKG, ".tmp-missing-peer-invoke.mjs");

/** Inline script that proves import + construction are light, initialize() throws. */
function buildMissingPeerScript(): string {
  return [
    'import { mkdtemp } from "node:fs/promises"; import { tmpdir } from "node:os"; import path from "node:path";',
    'import { MemoryClient } from "@atomicmemory/sdk";',
    'import { liveLlmwikiLazyEntry } from "./dist/register.js";',
    'process.stdout.write("IMPORTED;");',
    'const root = await mkdtemp(path.join(tmpdir(), "mp-"));',
    'const client = new MemoryClient({ providers: { "llmwiki-live": { root, projectId: "proj-1", scope: { user: "u1" } } }, defaultProvider: "llmwiki-live" });',
    'process.stdout.write("CONSTRUCTED;");',
    'try { await client.initialize({ "llmwiki-live": liveLlmwikiLazyEntry() }); process.stdout.write("NO_THROW"); }',
    'catch (e) { process.stdout.write("CODE:" + (e?.code ?? "none")); }',
  ].join("\n");
}

test("without llm-wiki-compiler: import + client construction stay LIGHT; initialize() throws E_LLMWIKI_COMPILER_MISSING", () => {
  writeFileSync(SCRIPT_PATH, buildMissingPeerScript(), "utf-8");
  // Initialized so a throw before assignment leaves a value the assert fails on.
  let out = "";
  let spawnError: unknown;
  try {
    out = execFileSync(
      process.execPath,
      ["--import", DENY_HOOK, SCRIPT_PATH],
      { encoding: "utf-8", cwd: PKG },
    );
  } catch (e) {
    spawnError = e;
  } finally {
    try { unlinkSync(SCRIPT_PATH); } catch { /* ignore cleanup failure */ }
  }
  // execFileSync pipes (not inherits) the subprocess's stderr, so a non-zero
  // exit would otherwise fail with the diagnostics hidden — surface them.
  if (spawnError) {
    const stderr = (spawnError as { stderr?: string }).stderr ?? "";
    throw new Error(
      `missing-peer subprocess failed: ${String(spawnError)}\n--- subprocess stderr ---\n${stderr}`,
      { cause: spawnError },
    );
  }
  assert.match(out, /IMPORTED;CONSTRUCTED;CODE:E_LLMWIKI_COMPILER_MISSING/);
});
