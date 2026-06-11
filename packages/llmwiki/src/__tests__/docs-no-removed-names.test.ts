/**
 * @file Docs-contract test: asserts that no doc file (README.md or docs/**\/*.md)
 * references the removed standalone provider names:
 *   - LLMWikiProvider
 *   - llmwikiProviderFactory
 *   - LLMWikiProviderOptions
 *
 * These were replaced by SnapshotLLMWikiProvider / snapshotLlmwikiProviderFactory /
 * SnapshotLLMWikiProviderOptions. The regexes use word-boundary-style lookaheads so
 * they do NOT match the current names that are substrings (Snapshot*, Live*).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..");

/** Match LLMWikiProvider not preceded or followed by an ASCII letter (so Snapshot/Live variants are excluded). */
const PROVIDER_CLASS_RE = /(?<![A-Za-z])LLMWikiProvider(?![A-Za-z])/g;
/** Match llmwikiProviderFactory not preceded or followed by an ASCII letter. */
const FACTORY_RE = /(?<![A-Za-z])llmwikiProviderFactory(?![A-Za-z])/g;
/** Match LLMWikiProviderOptions not preceded or followed by an ASCII letter. */
const OPTIONS_RE = /(?<![A-Za-z])LLMWikiProviderOptions(?![A-Za-z])/g;

/** Collect all .md files under a directory recursively. */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function findRemovedNames(content: string): string[] {
  const found: string[] = [];
  if (PROVIDER_CLASS_RE.test(content)) found.push("LLMWikiProvider");
  PROVIDER_CLASS_RE.lastIndex = 0;
  if (FACTORY_RE.test(content)) found.push("llmwikiProviderFactory");
  FACTORY_RE.lastIndex = 0;
  if (OPTIONS_RE.test(content)) found.push("LLMWikiProviderOptions");
  OPTIONS_RE.lastIndex = 0;
  return found;
}

test("no doc file references removed standalone provider names", () => {
  const readmePath = join(PACKAGE_ROOT, "README.md");
  const docsDir = join(PACKAGE_ROOT, "docs");

  const filesToCheck = [readmePath, ...collectMarkdownFiles(docsDir)];
  const violations: string[] = [];

  for (const filePath of filesToCheck) {
    const content = readFileSync(filePath, "utf-8");
    const hits = findRemovedNames(content);
    if (hits.length > 0) {
      const relative = filePath.replace(PACKAGE_ROOT + "/", "");
      violations.push(`${relative}: found removed name(s): ${hits.join(", ")}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "Doc files reference removed provider names. Replace with SnapshotLLMWikiProvider / " +
      "snapshotLlmwikiProviderFactory / SnapshotLLMWikiProviderOptions:\n" +
      violations.join("\n"),
  );
});
