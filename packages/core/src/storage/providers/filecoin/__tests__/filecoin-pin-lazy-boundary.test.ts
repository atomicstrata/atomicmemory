/**
 * @file Phase 5 lazy-load invariant — the filecoin-pin module
 * subtree must be reachable ONLY through a dynamic import inside
 * `providers/filecoin/index.ts`'s `filecoin_pin` branch.
 *
 * The Phase 2 boundary test (`lazy-loading-boundary.test.ts`)
 * already proves no shared core file outside
 * `providers/filecoin/` reaches `filecoin-pin` at all. This test
 * adds a second invariant: WITHIN `providers/filecoin/`, the
 * synapse-only construction path
 * (`index.ts → backend.ts / synapse-client.ts /
 * synapse-construction.ts`) must NOT statically import any of
 * the filecoin-pin modules. The intent is that a deployment
 * running the default `RAW_STORAGE_FILECOIN_DRIVER=synapse` does
 * not need the `filecoin-pin` package installed at all — it's
 * declared in `package.json:optionalDependencies` precisely so a
 * synapse-only build can skip it.
 *
 * Implementation: AST-scan the transitive static-import closure
 * of `index.ts`. The closure must not contain any module under
 * `providers/filecoin/filecoin-pin-*.ts` AND must not specify any
 * filecoin-pin / Helia / IPLD-CAR / blockstore vendor package.
 * `index.ts` reaches the filecoin-pin client only via a dynamic
 * import (a runtime `import(...)` call); dynamic imports do not
 * appear in the static closure, which is the property under test.
 *
 * The static-closure check covers the RUNTIME side of the
 * invariant. The DEPENDENCY side (a synapse-only install can
 * skip the heavy graph via `npm install --omit=optional`) is
 * covered by the `package.json` declaration check below: every
 * filecoin-pin-only package must live in `optionalDependencies`,
 * never in `dependencies`. A regression that promotes one of
 * those packages to a hard dep would force every consumer to
 * download the full graph regardless of driver selection.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DIR,
  SRC_ROOT,
  extractImports,
  type ImportSpecifier,
} from './import-boundary-helpers.js';

const INDEX_TS = path.resolve(PROVIDER_DIR, 'index.ts');

const FILECOIN_PIN_VENDOR_RE = /^(filecoin-pin(\/|$)|@helia\/|@ipld\/car(\/|$)|blockstore-core(\/|$))/;

function resolveSibling(importingFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = path.dirname(importingFile);
  const stripped = specifier.replace(/\.js$/, '');
  const candidate = path.resolve(dir, `${stripped}.ts`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Walk the STATIC import closure of `entry` inside the provider
 * directory. Dynamic-import specifiers are skipped — they are the
 * lazy seam we are trying to verify.
 */
function staticClosure(entry: string): {
  files: ReadonlySet<string>;
  vendorSpecs: ReadonlyArray<ImportSpecifier>;
} {
  const seen = new Set<string>();
  const vendor: ImportSpecifier[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of extractImports(source, file)) {
      if (spec.kind !== 'static') continue;
      if (spec.modulePath.startsWith('.')) {
        const resolved = resolveSibling(file, spec.modulePath);
        if (resolved !== null) stack.push(resolved);
        continue;
      }
      vendor.push(spec);
    }
  }
  return { files: seen, vendorSpecs: vendor };
}

describe('filecoin-pin lazy-load invariant — static closure of index.ts', () => {
  const closure = staticClosure(INDEX_TS);

  it('does not reach filecoin-pin-client.ts statically', () => {
    const reached = [...closure.files].filter((f) => f.endsWith('filecoin-pin-client.ts'));
    expect(reached).toEqual([]);
  });

  it('does not reach filecoin-pin-car.ts statically', () => {
    const reached = [...closure.files].filter((f) => f.endsWith('filecoin-pin-car.ts'));
    expect(reached).toEqual([]);
  });

  it('does not statically import any filecoin-pin / @helia / @ipld/car / blockstore-core vendor package', () => {
    const violators = closure.vendorSpecs.filter((s) => FILECOIN_PIN_VENDOR_RE.test(s.modulePath));
    expect(violators).toEqual([]);
  });

  it('but index.ts DOES contain a dynamic import to the filecoin-pin client (the lazy seam)', () => {
    const source = readFileSync(INDEX_TS, 'utf8');
    const specs = extractImports(source, INDEX_TS);
    // The expected suffix is assembled from name fragments so
    // fallow's import scanner does NOT misread this literal as a
    // direct relative import from this test file. The test only
    // inspects the SOURCE TEXT of `index.ts`.
    const expectedSuffix = '/' + 'filecoin-pin-client' + '.js';
    const dyn = specs.filter((s) => s.kind === 'dynamic' && s.modulePath.endsWith(expectedSuffix));
    expect(dyn.length).toBeGreaterThanOrEqual(1);
  });
});

describe('filecoin-pin install invariant — `npm ci --legacy-peer-deps --omit=optional` skips the heavy graph', () => {
  // The repo policy is `legacy-peer-deps` (long-standing
  // openai/zod peer conflict in the transitive graph), so the
  // install command operators actually run is:
  //   npm ci --legacy-peer-deps                      [default install]
  //   npm ci --legacy-peer-deps --omit=optional      [synapse-only build]
  // The clean-install command + its result is documented in the
  // research-repo evaluation note (search for "Clean-install
  // proof").
  // The dependency-side complement to the static-closure check
  // above. Every filecoin-driver-only optional package MUST live
  // under `optionalDependencies` so a synapse-only install can
  // opt out. Promoting any of these to a hard dependency would
  // break the "synapse default is install-cheap" guarantee. The
  // list spans Phase 5 (filecoin-pin driver) AND Phase 6
  // (verified-fetch retriever); rename to a generic constant if
  // a future phase adds more optional Filecoin packages.
  const PHASE_5_6_OPTIONAL = [
    'filecoin-pin',
    '@helia/unixfs',
    // Phase 6 adds the verified-fetch retriever as another opt-in
    // optional. Same install policy: a synapse-only build skips
    // it via `npm ci --legacy-peer-deps --omit=optional`.
    '@helia/verified-fetch',
    '@ipld/car',
    'blockstore-core',
    'pino',
  ] as const;

  const pkg = JSON.parse(
    readFileSync(path.resolve(SRC_ROOT, '..', 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  it.each(PHASE_5_6_OPTIONAL)('%s is declared under optionalDependencies, not dependencies', (name) => {
    expect(pkg.dependencies?.[name]).toBeUndefined();
    expect(pkg.optionalDependencies?.[name]).toMatch(/^[\^~]?[\d.]+/);
  });
});

describe('filecoin-pin source-build invariant — production source compiles without optionalDependencies', () => {
  // The complement to the package.json declaration check above:
  // the actual SOURCE files inside `providers/filecoin/` must
  // NOT statically import any optional vendor package. A static
  // import would force `tsc --noEmit` /
  // `tsc -p tsconfig.build.json` to resolve the package at
  // type-check time — which fails when an operator runs
  // `npm ci --legacy-peer-deps --omit=optional` for a
  // synapse-only build. Runtime `await import(...)` calls are
  // fine; they're the lazy seam.
  const SOURCE_FILES = [
    path.resolve(PROVIDER_DIR, 'filecoin-pin-client.ts'),
    path.resolve(PROVIDER_DIR, 'filecoin-pin-car.ts'),
    path.resolve(PROVIDER_DIR, 'filecoin-pin-vendor.ts'),
    path.resolve(PROVIDER_DIR, 'filecoin-pin-timeout.ts'),
    path.resolve(PROVIDER_DIR, 'filecoin-pin-mapping.ts'),
    // Phase 6 — the verified-fetch retriever is the same kind of
    // optionalDependency-backed module the Phase 5 split was, and
    // is held to the same source-build-safety invariant.
    path.resolve(PROVIDER_DIR, 'verified-fetch-retriever.ts'),
    path.resolve(PROVIDER_DIR, 'verified-fetch-vendor.ts'),
    path.resolve(PROVIDER_DIR, 'verified-fetch-lifecycle.ts'),
  ];
  const FORBIDDEN_STATIC_RE =
    /^(filecoin-pin(\/|$)|@helia\/unixfs|@helia\/verified-fetch|@ipld\/car(\/|$)|blockstore-core(\/|$)|pino(\/|$))/;

  it.each(SOURCE_FILES)('%s contains no static import of an optional package', (file) => {
    const source = readFileSync(file, 'utf8');
    const violators = extractImports(source, file).filter(
      (s) => s.kind === 'static' && FORBIDDEN_STATIC_RE.test(s.modulePath),
    );
    expect(violators).toEqual([]);
  });
});
