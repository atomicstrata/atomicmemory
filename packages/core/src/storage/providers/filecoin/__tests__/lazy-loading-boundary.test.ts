/**
 * @file Phase 2 lazy-loading boundary — Filecoin-specific vendor
 * packages may only be imported (statically OR dynamically) from
 * inside `src/storage/providers/filecoin/`. The factory at
 * `src/storage/factory.ts` dynamic-imports
 * `./providers/filecoin/index.js`; everything heavy lives behind
 * that single seam.
 *
 * `viem` is NOT on this list because it's a generic Ethereum
 * library that other parts of core may legitimately use. Only
 * the Filecoin-specific surface is gated:
 *   - `@filoz/synapse-sdk` (and subpaths)
 *   - `filecoin-pin`           (future Phase 5 driver)
 *   - `@helia/verified-fetch`  (future Phase 6 retriever)
 *
 * The future packages aren't installed yet — listing them now
 * preemptively forbids a careless lazy import in shared core
 * paths the day someone adds them.
 *
 * Split out of `import-boundary.test.ts` so each test file stays
 * under the workspace 400-LOC cap (AGENTS.md). Shared helpers +
 * types live in `import-boundary-helpers.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractImports,
  PROVIDER_DIR,
  SRC_ROOT,
  type ImportViolation,
} from './import-boundary-helpers.js';

const FILECOIN_VENDOR_RE = /^(@filoz\/|filecoin-pin(\/|$)|@helia\/verified-fetch(\/|$))/;

function walkSrcExcludingProviderDir(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (abs === PROVIDER_DIR) continue; // entire provider subtree skipped
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
    }
  }
  walk(SRC_ROOT);
  return out;
}

interface VendorViolation extends ImportViolation {
  readonly kind: 'static' | 'dynamic';
}

function collectFilecoinVendorViolations(): VendorViolation[] {
  const violations: VendorViolation[] = [];
  for (const file of walkSrcExcludingProviderDir()) {
    const imports = extractImports(readFileSync(file, 'utf8'), file);
    for (const spec of imports) {
      if (FILECOIN_VENDOR_RE.test(spec.modulePath)) {
        violations.push({
          file: path.relative(SRC_ROOT, file),
          line: spec.line,
          modulePath: spec.modulePath,
          kind: spec.kind,
        });
      }
    }
  }
  return violations;
}

describe('Filecoin provider — lazy-loading boundary (Phase 2)', () => {
  it('no file outside providers/filecoin/ statically imports @filoz/* / filecoin-pin / @helia/verified-fetch', () => {
    const staticViolations = collectFilecoinVendorViolations().filter((v) => v.kind === 'static');
    expect(staticViolations).toEqual([]);
  });

  it('no file outside providers/filecoin/ dynamically imports @filoz/* / filecoin-pin / @helia/verified-fetch', () => {
    // Heavy Filecoin packages must resolve only through the
    // single `factory.ts → providers/filecoin/index.js` seam.
    // A direct lazy import anywhere else would re-introduce the
    // eager-load coupling the lazy-load refactor cuts.
    const dynamicViolations = collectFilecoinVendorViolations().filter((v) => v.kind === 'dynamic');
    expect(dynamicViolations).toEqual([]);
  });

  it('detector positive controls (synthetic): plant violations and confirm the regex catches them', () => {
    // Defense-in-depth: ensure the regex actually fires on the
    // forbidden specifiers. If this test breaks, the production
    // scans above may be silently passing on planted violations.
    expect(FILECOIN_VENDOR_RE.test('@filoz/synapse-sdk')).toBe(true);
    expect(FILECOIN_VENDOR_RE.test('@filoz/synapse-core/utils')).toBe(true);
    expect(FILECOIN_VENDOR_RE.test('filecoin-pin')).toBe(true);
    expect(FILECOIN_VENDOR_RE.test('filecoin-pin/dist/some-internal.js')).toBe(true);
    expect(FILECOIN_VENDOR_RE.test('@helia/verified-fetch')).toBe(true);
    expect(FILECOIN_VENDOR_RE.test('@helia/verified-fetch/some-sub')).toBe(true);
    // viem is NOT Filecoin-specific — must not be flagged.
    expect(FILECOIN_VENDOR_RE.test('viem')).toBe(false);
    expect(FILECOIN_VENDOR_RE.test('viem/accounts')).toBe(false);
    // Unrelated packages also not flagged.
    expect(FILECOIN_VENDOR_RE.test('@helia/some-other')).toBe(false);
    expect(FILECOIN_VENDOR_RE.test('@filozzz/typo')).toBe(false);
  });

  it('synthetic backtick-import: vendor scan catches `await import(`@filoz/...`)` (no-substitution template literal)', () => {
    // Defense-in-depth for the BLOCKER 2 fix: a careless
    // backtick-quoted vendor import must be detected. If the
    // scanner regressed to string-literal-only matching, this
    // synthetic would silently pass.
    const synthetic = 'export async function leak() { return await import(`@filoz/synapse-sdk`); }';
    const specs = extractImports(synthetic);
    const vendorHits = specs.filter((s) => FILECOIN_VENDOR_RE.test(s.modulePath));
    expect(vendorHits).toHaveLength(1);
    expect(vendorHits[0]?.kind).toBe('dynamic');
    expect(vendorHits[0]?.modulePath).toBe('@filoz/synapse-sdk');
  });
});
