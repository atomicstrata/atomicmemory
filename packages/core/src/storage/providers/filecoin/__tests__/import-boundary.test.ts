/**
 * @file Production-side import-boundary tests for the Filecoin
 * provider. Scans real source files via the TypeScript compiler
 * API (no module loads, no side effects) and asserts the import
 * contract in both directions:
 *
 *   1. FORWARD — no file under `src/routes/`, `src/middleware/`,
 *      `src/services/`, `src/db/`, `src/app/`, or `src/schemas/`
 *      imports directly from `src/storage/providers/filecoin/*`.
 *      The ONE intentional exception is the composition seam in
 *      `src/storage/factory.ts` — explicitly allowlisted, AND
 *      required to use a DYNAMIC import (Phase 2 lazy-load
 *      contract).
 *
 *   2. REVERSE — files under `src/storage/providers/filecoin/`
 *      only import from a closed allowlist: sibling files in the
 *      provider directory (and its `__tests__/`), the shared
 *      storage contracts/utilities under `src/storage/*`, Node
 *      built-ins, the vendor SDK, and (in tests) `vitest` +
 *      `typescript`. Anything else fails the test.
 *
 * Scanner shape coverage lives in
 * `import-boundary-scanner.test.ts`; the Phase 2 vendor-package
 * lazy-loading checks live in `lazy-loading-boundary.test.ts`.
 * Shared helpers live in `import-boundary-helpers.ts`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyReverseImport,
  collectForwardViolations,
  extractImports,
  FAKE_PROVIDER_ROOT_FILE,
  FAKE_PROVIDER_TEST_FILE,
  PROVIDER_DIR,
  PROVIDER_SPECIFIER_RE,
  SRC_ROOT,
  walkTsFiles,
  type ImportSpecifier,
  type ImportViolation,
} from './import-boundary-helpers.js';

describe('Filecoin provider — forward import boundary', () => {
  it('no file under routes/middleware/services/db/app/schemas imports from providers/filecoin/* (except the documented factory seam)', () => {
    expect(collectForwardViolations()).toEqual([]);
  });

  it('storage/factory.ts is the only allowlisted forward consumer AND uses a dynamic import (Phase 2 lazy-load contract)', () => {
    const factory = path.resolve(SRC_ROOT, 'storage', 'factory.ts');
    const imports = extractImports(readFileSync(factory, 'utf8'), factory);
    const hits = imports.filter((i) => PROVIDER_SPECIFIER_RE.test(i.modulePath));
    expect(hits.length).toBeGreaterThan(0);
    // Factory should import the explicit composition entry point,
    // not deep internals.
    for (const hit of hits) {
      expect(hit.modulePath).toMatch(/providers\/filecoin(\/index)?(\.js)?$/);
    }
    // Phase 2: factory MUST use dynamic import (not static). The
    // heavy `@filoz/synapse-sdk` + `viem` packages transitively
    // resolve only when `RAW_STORAGE_PROVIDER=filecoin`; a static
    // import here would pull them in on every non-Filecoin startup.
    for (const hit of hits) {
      expect(hit.kind).toBe('dynamic');
    }
  });

  it('storage/filecoin-public-metadata.ts is provider-neutral (no providers/filecoin/* import)', () => {
    const shared = path.resolve(SRC_ROOT, 'storage', 'filecoin-public-metadata.ts');
    const imports = extractImports(readFileSync(shared, 'utf8'), shared);
    for (const { modulePath } of imports) {
      expect(modulePath).not.toMatch(PROVIDER_SPECIFIER_RE);
    }
  });
});

describe('Filecoin provider — reverse import boundary', () => {
  it('every import inside providers/filecoin/ is allowlisted', () => {
    const violations: ImportViolation[] = [];
    for (const file of walkTsFiles(PROVIDER_DIR)) {
      const imports = extractImports(readFileSync(file, 'utf8'), file);
      for (const spec of imports) {
        if (classifyReverseImport(spec, file) === 'violation') {
          violations.push({
            file: path.relative(SRC_ROOT, file),
            line: spec.line,
            modulePath: spec.modulePath,
          });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects any import from the central src/config.ts (type-only OR value) — provider-root', () => {
    const valueImport = extractImports("import { config } from '../../../config.js';");
    expect(valueImport).toHaveLength(1);
    expect(classifyReverseImport(valueImport[0]!, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');

    const typeImport = extractImports(
      "import type { RuntimeConfig } from '../../../config.js';",
    );
    expect(typeImport).toHaveLength(1);
    expect(typeImport[0]!.isTypeOnly).toBe(true);
    expect(classifyReverseImport(typeImport[0]!, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');
  });

  it('rejects deep-internal paths via file-aware resolution', () => {
    for (const m of [
      '../../../routes/storage.js',
      '../../../middleware/auth.js',
      '../../../db/storage-artifact-repository.js',
      '../../../services/document-upload.js',
      '../../../app/runtime-container.js',
      '../../../schemas/document-response-schemas.js',
      '@atomicmemory/atomicmem-sdk',
    ]) {
      const spec: ImportSpecifier = { modulePath: m, line: 1, isTypeOnly: false, kind: 'static' };
      expect(classifyReverseImport(spec, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');
    }
  });

  it('REJECTS a provider-root file importing ../other-provider.js (escape outside providers/filecoin/)', () => {
    const escape: ImportSpecifier = {
      modulePath: '../other-provider.js',
      line: 1,
      isTypeOnly: false,
      kind: 'static',
    };
    // From `providers/filecoin/<x>.ts`, `../other-provider.js`
    // resolves to `providers/other-provider.ts` — outside
    // PROVIDER_DIR and not on the shared-storage allowlist.
    expect(classifyReverseImport(escape, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');
  });

  it('ALLOWS a __tests__ file importing ../config.js (resolves inside providers/filecoin/)', () => {
    const sibling: ImportSpecifier = {
      modulePath: '../config.js',
      line: 1,
      isTypeOnly: false,
      kind: 'static',
    };
    // From `providers/filecoin/__tests__/<x>.test.ts`, `../config.js`
    // resolves to `providers/filecoin/config.ts` — inside
    // PROVIDER_DIR.
    expect(classifyReverseImport(sibling, FAKE_PROVIDER_TEST_FILE)).toBe('allow');
  });

  it('rejects ../../../config.js from a __tests__ file too (climbs out to src/config.ts)', () => {
    const escape: ImportSpecifier = {
      modulePath: '../../../config.js',
      line: 1,
      isTypeOnly: true,
      kind: 'static',
    };
    expect(classifyReverseImport(escape, FAKE_PROVIDER_TEST_FILE)).toBe('violation');
  });

  it('allows the shared-storage allowlist from a provider-root file', () => {
    const allowed: ImportSpecifier = {
      modulePath: '../../raw-content-store.js',
      line: 1,
      isTypeOnly: false,
      kind: 'static',
    };
    expect(classifyReverseImport(allowed, FAKE_PROVIDER_ROOT_FILE)).toBe('allow');
  });

  // Test-time package gating — `vitest` and `typescript` are legal
  // imports ONLY inside `providers/filecoin/__tests__/`. A
  // production provider file importing them is a violation no
  // matter how innocuous the package looks.
  it.each(['vitest', 'typescript'])(
    'REJECTS a PRODUCTION provider file importing test-time package %s',
    (pkg) => {
      const spec: ImportSpecifier = {
        modulePath: pkg,
        line: 1,
        isTypeOnly: false,
        kind: 'static',
      };
      expect(classifyReverseImport(spec, FAKE_PROVIDER_ROOT_FILE)).toBe('violation');
    },
  );

  it.each(['vitest', 'typescript'])(
    'ALLOWS a provider __tests__ file importing test-time package %s',
    (pkg) => {
      const spec: ImportSpecifier = {
        modulePath: pkg,
        line: 1,
        isTypeOnly: false,
        kind: 'static',
      };
      expect(classifyReverseImport(spec, FAKE_PROVIDER_TEST_FILE)).toBe('allow');
    },
  );
});
