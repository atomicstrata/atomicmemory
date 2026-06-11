/**
 * Import-boundary guard: the root barrel (`@atomicmemory/llmwiki` → `src/index.ts`) and
 * everything it transitively imports must NOT statically import `llm-wiki-compiler`.
 * Only `src/live/*` (reachable via the `./live` entry) and `src/live.ts` (the live barrel)
 * are permitted to pull in the heavy compiler SDK.
 *
 * This is a structural (static-analysis) test — it reads TypeScript source files directly
 * and checks for import statements, so it is reliable under tsx without any module cache tricks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await tsFiles(full));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** All src/**\/*.ts files except live/*, live.ts, and __tests__/*. */
async function lightSourceFiles(): Promise<string[]> {
  return (await tsFiles(SRC)).filter((f) =>
    !f.includes(`${path.sep}live${path.sep}`) &&
    f !== path.join(SRC, "live.ts") &&
    !f.includes(`${path.sep}__tests__${path.sep}`));
}

describe("import boundary: only ./live pulls llm-wiki-compiler", () => {
  it("no non-live source module imports llm-wiki-compiler", async () => {
    const files = await lightSourceFiles();
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, "utf-8");
      if (/\bfrom\s+["']llm-wiki-compiler["']|import\(\s*["']llm-wiki-compiler["']\s*\)/.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    assert.deepEqual(offenders, [], `these non-live modules import llm-wiki-compiler: ${offenders.join(", ")}`);
  });

  it("the root barrel does not re-export from ./live", async () => {
    const index = await readFile(path.join(SRC, "index.ts"), "utf-8");
    assert.equal(/from\s+["']\.\/live(\/|\.js|["'])/.test(index), false, "index.ts must not export the ./live subtree");
  });

  it("no non-live module statically VALUE-imports the ./live subtree", async () => {
    // Every src/**/*.ts file except live/*, live.ts, and __tests__/* must not statically
    // VALUE-import from ./live/ or ../live/ (either depth). Type-only and dynamic imports
    // are allowed. Covers register.ts and all other light modules (e.g. register-internals.ts).
    const files = await lightSourceFiles();
    const offenders: string[] = [];
    for (const f of files) {
      const src = await readFile(f, "utf-8");
      const linesWithoutPureTypeImports = stripTypeOnlyImportLines(src);
      // Match both ./live/... (same depth as src/) and ../live/... (files in subdirs of src/)
      if (/from\s+["']\.\.?\/live\/[^"']+["']/.test(linesWithoutPureTypeImports)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    assert.deepEqual(offenders, [], `these non-live modules statically VALUE-import from ./live: ${offenders.join(", ")}`);
  });
});

/**
 * Strip `import type …` and all-type inline imports so the remaining text can
 * be scanned for VALUE imports. The stripping logic is intentionally coarse —
 * it only needs to avoid false positives (type-only lines that look like value
 * imports); false negatives (missed value imports) are security-relevant so we
 * err on the side of keeping lines.
 */
function stripTypeOnlyImportLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      // Drop `import type ...` (whole-import type erasure)
      if (/^\s*import\s+type\s+/.test(line)) return false;
      // Drop lines where every named binding is prefixed with `type` (inline type-only)
      // e.g. `import { type Foo, type Bar } from "..."` → all bindings are `type X`.
      // Only when nothing but whitespace sits between `import` and `{` — a default
      // binding before the brace (`import Foo, { type Bar } ...`) is a VALUE import.
      const namedMatch = line.match(/import\s+\{([^}]+)\}/);
      const noDefaultBeforeBrace = /import\s*\{/.test(line);
      if (namedMatch && noDefaultBeforeBrace) {
        const bindings = namedMatch[1].split(",").map((b) => b.trim());
        if (bindings.every((b) => b.startsWith("type "))) return false;
      }
      return true;
    })
    .join("\n");
}
