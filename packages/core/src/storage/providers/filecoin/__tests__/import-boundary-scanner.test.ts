/**
 * @file Shape/unit coverage for the AST-based import scanner used
 * by the Filecoin import-boundary tests. Split out of
 * `import-boundary.test.ts` to keep both files under the workspace
 * 400-LOC cap (AGENTS.md).
 *
 * Covers:
 *   - static single-line + multiline `import` and `export ... from`
 *   - `import type` / `export type ... from` modifier propagation
 *   - dynamic `await import(...)` calls (top-level + nested)
 *   - rejection of non-string-literal dynamic specifiers (template
 *     literals, runtime variables — out of static scope)
 *   - side-effect imports with no bindings
 *   - synthetic classifier round-trips via `classifyReverseImport`
 *
 * Production boundary assertions live in `import-boundary.test.ts`;
 * Phase 2 vendor-package lazy-loading checks live in
 * `lazy-loading-boundary.test.ts`. Shared helpers + types live in
 * `import-boundary-helpers.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyReverseImport,
  extractImports,
  FAKE_PROVIDER_ROOT_FILE,
  PROVIDER_SPECIFIER_RE,
} from './import-boundary-helpers.js';

describe('extractImports — multiline / shape coverage', () => {
  it('captures a single-line static import', () => {
    const out = extractImports("import { x } from './sibling.js';");
    expect(out).toEqual([{ modulePath: './sibling.js', line: 1, isTypeOnly: false, kind: 'static' }]);
  });

  it('captures a MULTILINE static import (the bug a line-based scanner misses)', () => {
    const out = extractImports(
      [
        'import {',
        '  createFilecoinStorageBackend,',
        "} from './providers/filecoin/index.js';",
        '',
      ].join('\n'),
    );
    expect(out).toEqual([
      { modulePath: './providers/filecoin/index.js', line: 3, isTypeOnly: false, kind: 'static' },
    ]);
  });

  it('captures a MULTILINE export ... from declaration', () => {
    const out = extractImports(
      [
        'export {',
        '  FilecoinRawContentStore,',
        '  type FilecoinPublicMetadata,',
        "} from '../filecoin-public-metadata.js';",
      ].join('\n'),
    );
    expect(out).toEqual([
      { modulePath: '../filecoin-public-metadata.js', line: 4, isTypeOnly: false, kind: 'static' },
    ]);
  });

  it('marks `import type` as type-only', () => {
    const out = extractImports("import type { T } from '../../../config.js';");
    expect(out).toHaveLength(1);
    expect(out[0]!.isTypeOnly).toBe(true);
  });

  it('marks `export type ... from` as type-only', () => {
    const out = extractImports("export type { T } from '../shared.js';");
    expect(out).toHaveLength(1);
    expect(out[0]!.isTypeOnly).toBe(true);
  });

  it('correctly classifies a multiline forbidden provider import as violation', () => {
    const synthetic = [
      'import {',
      '  createFilecoinStorageBackend,',
      "} from '../../../storage/providers/filecoin/index.js';",
    ].join('\n');
    const specs = extractImports(synthetic);
    expect(specs.some((s) => PROVIDER_SPECIFIER_RE.test(s.modulePath))).toBe(true);
  });

  it('correctly classifies a multiline allowed sibling import', () => {
    const synthetic = [
      'import {',
      '  FILECOIN_METADATA_DENYLIST,',
      '  FILECOIN_METADATA_RESERVED_PREFIXES,',
      "} from './metadata.js';",
    ].join('\n');
    const specs = extractImports(synthetic);
    expect(specs).toHaveLength(1);
    expect(classifyReverseImport(specs[0]!, FAKE_PROVIDER_ROOT_FILE)).toBe('allow');
  });

  it('correctly classifies a multiline forbidden config type import as violation', () => {
    const synthetic = [
      'import type {',
      '  RuntimeConfig,',
      '  FilecoinNetwork,',
      "} from '../../../config.js';",
    ].join('\n');
    const specs = extractImports(synthetic);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.isTypeOnly).toBe(true);
    expect(classifyReverseImport(specs[0]!, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');
  });

  it('handles a side-effect import with no bindings', () => {
    const out = extractImports("import './side-effect.js';");
    expect(out).toEqual([{ modulePath: './side-effect.js', line: 1, isTypeOnly: false, kind: 'static' }]);
  });

  it('captures a top-level dynamic import call', () => {
    const out = extractImports("const m = await import('./lazy.js');");
    expect(out).toEqual([{ modulePath: './lazy.js', line: 1, isTypeOnly: false, kind: 'dynamic' }]);
  });

  it('captures a dynamic import nested inside an async function body', () => {
    const out = extractImports(
      [
        'export async function build() {',
        "  const { x } = await import('./providers/filecoin/index.js');",
        '  return x;',
        '}',
      ].join('\n'),
    );
    expect(out).toEqual([
      {
        modulePath: './providers/filecoin/index.js',
        line: 2,
        isTypeOnly: false,
        kind: 'dynamic',
      },
    ]);
  });

  it('captures a dynamic import with a no-substitution template literal (backtick)', () => {
    // Backtick-quoted specifiers without `${...}` are statically
    // knowable — the scanner MUST treat them the same as
    // single/double-quoted string literals. Otherwise a careless
    // `await import(`@filoz/synapse-sdk`)` would bypass the
    // Phase 2 vendor-boundary scan.
    const out = extractImports('const m = await import(`./lazy.js`);');
    expect(out).toEqual([{ modulePath: './lazy.js', line: 1, isTypeOnly: false, kind: 'dynamic' }]);
  });

  it('ignores dynamic imports with template-literal specifiers that contain substitutions', () => {
    // `${...}` makes the specifier runtime-dependent and outside
    // this scanner's contract.
    const out = extractImports('const m = await import(`./${name}.js`);');
    expect(out).toEqual([]);
  });
});
