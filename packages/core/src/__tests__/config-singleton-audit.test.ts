/**
 * Config singleton import regression gate.
 *
 * Counts the non-test source files that bind the module-level config
 * singleton value from config.js (any import/export pattern). The threshold
 * should only move DOWN as config-threading PRs land. Any PR that adds
 * a new singleton import must raise the threshold explicitly — that
 * friction is the point.
 *
 * This test does not depend on a live database or runtime — it reads
 * source files statically, matching the pattern in
 * deployment-config.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..');

/**
 * Maximum allowed non-test source files that bind the runtime config
 * singleton value from config.js. Ratchet this DOWN after each
 * config-threading PR lands.
 * Current baseline: 28 files after Phase 7 Step 3d-llm dropped llm.ts
 * from the singleton importer set (same module-local-init pattern as
 * embedding). Five Step 3d leaves complete: consensus-extraction,
 * write-security, cost-telemetry, embedding, llm.
 * Includes multi-import forms (e.g. `import { config, updateRuntimeConfig }`)
 * and re-exports (e.g. `export { config } from`).
 */
const MAX_SINGLETON_IMPORTS = 28;

/**
 * Matches any import or re-export that binds the `config` value (not
 * just a type) from a path ending in `config.js` or `config`. Covers
 * single-line and multiline import blocks:
 *   import { config } from '../config.js'
 *   import { config, updateRuntimeConfig } from '../config.js'
 *   import {\n  config,\n  updateRuntimeConfig,\n} from '../config.js'
 *   export { config, ... } from './config.js'
 * Excludes `import type`-only statements.
 */
const CONFIG_BINDING_RE = /(?:import|export)\s*\{[^}]*\bconfig\b[^}]*\}\s*from\s*['"][^'"]*config/s;
const IMPORT_TYPE_ONLY_RE = /import\s+type\s*\{/;

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      results.push(full);
    }
  }
  return results;
}

function findSingletonImporters(): string[] {
  const files = collectTsFiles(SRC);
  const matches: string[] = [];
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    // Find all import/export blocks from a config path that bind `config`
    const hits = content.match(new RegExp(CONFIG_BINDING_RE.source, 'gs')) ?? [];
    const hasRuntimeBinding = hits.some((hit) => !IMPORT_TYPE_ONLY_RE.test(hit));
    if (hasRuntimeBinding) matches.push(filePath);
  }
  return matches.sort();
}

describe('config singleton regression gate', () => {
  it(`non-test source files importing config singleton must not exceed ${MAX_SINGLETON_IMPORTS}`, () => {
    const files = findSingletonImporters();

    expect(files.length).toBeLessThanOrEqual(MAX_SINGLETON_IMPORTS);

    // Print the list on failure so the developer knows exactly which
    // files to inspect or thread.
    if (files.length > MAX_SINGLETON_IMPORTS) {
      console.error(
        `Config singleton imports (${files.length}) exceed threshold (${MAX_SINGLETON_IMPORTS}):\n` +
          files.map((f) => `  ${f}`).join('\n'),
      );
    }
  });

  it('threshold is not stale (count should be close to threshold)', () => {
    const files = findSingletonImporters();
    const slack = MAX_SINGLETON_IMPORTS - files.length;

    // If the threshold has more than 5 files of slack, a threading PR
    // landed without ratcheting the threshold down. Warn but don't fail
    // — the primary gate is the upper-bound test above.
    if (slack > 5) {
      console.warn(
        `Config singleton threshold has ${slack} files of slack ` +
          `(threshold=${MAX_SINGLETON_IMPORTS}, actual=${files.length}). ` +
          `Consider ratcheting MAX_SINGLETON_IMPORTS down to ${files.length + 2}.`,
      );
    }
  });
});
