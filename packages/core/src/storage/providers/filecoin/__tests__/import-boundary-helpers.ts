/**
 * @file Shared helpers for the Filecoin import-boundary test
 * suite. Split out of `import-boundary.test.ts` to keep every
 * test file under the workspace 400-LOC cap (AGENTS.md).
 *
 * Filename intentionally lacks the `.test.ts` suffix so vitest's
 * `*.test.ts` discovery in `vitest.config.ts` skips it as
 * runnable tests — these are pure helpers consumed by the sibling
 * `import-boundary.test.ts`,
 * `import-boundary-scanner.test.ts`, and
 * `lazy-loading-boundary.test.ts` files.
 *
 * Contract surface exported:
 *   - `SRC_ROOT`, `PROVIDER_DIR` — anchor paths for boundary scans
 *   - `PROVIDER_SPECIFIER_RE` — regex matching the forbidden
 *     forward-import substring
 *   - `FAKE_PROVIDER_ROOT_FILE`, `FAKE_PROVIDER_TEST_FILE` —
 *     synthetic paths for classifier unit tests
 *   - `ImportSpecifier`, `ImportViolation` — shared shape types
 *   - `extractImports` — AST-based static + dynamic import scanner
 *   - `walkTsFiles` — filesystem walker
 *   - `collectForwardViolations` — production forward-boundary scan
 *   - `classifyReverseImport` — classifier for the reverse boundary
 *
 * Forward-allowlist / scan-roots / vendor-package / test-time
 * allowlists are file-local because no test consumer needs them
 * directly — `collectForwardViolations` and `classifyReverseImport`
 * are the public seams.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const PROVIDER_DIR = path.resolve(SRC_ROOT, 'storage', 'providers', 'filecoin');
const PROVIDER_TESTS_DIR = path.resolve(PROVIDER_DIR, '__tests__');

const FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  // The single composition seam — factory dispatch into the provider.
  path.resolve(SRC_ROOT, 'storage', 'factory.ts'),
]);

const FORWARD_SCAN_ROOTS: ReadonlyArray<string> = [
  path.resolve(SRC_ROOT, 'routes'),
  path.resolve(SRC_ROOT, 'middleware'),
  path.resolve(SRC_ROOT, 'services'),
  path.resolve(SRC_ROOT, 'db'),
  path.resolve(SRC_ROOT, 'app'),
  path.resolve(SRC_ROOT, 'schemas'),
];

export const PROVIDER_SPECIFIER_RE = /providers\/filecoin/;

export interface ImportSpecifier {
  readonly modulePath: string;
  readonly line: number;
  readonly isTypeOnly: boolean;
  /**
   * `'static'` — top-level import / export-from declaration whose
   * specifier is a string literal. Resolved at module load.
   * `'dynamic'` — call expression whose callee is `ImportKeyword`
   * with a STATICALLY-KNOWN string-literal OR no-substitution
   * template-literal argument (both expose `.text` at parse time).
   * Template expressions with substitutions (`${...}`) stay out
   * of static scope — their specifiers are runtime-dependent.
   * Phase 2 of the harvest plan requires heavy Filecoin packages
   * load only via the dynamic form, and only from inside
   * `providers/filecoin/` (or via the documented factory seam).
   */
  readonly kind: 'static' | 'dynamic';
}

export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly modulePath: string;
}

export function walkTsFiles(
  root: string,
  options: { skipTestDirs?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (options.skipTestDirs && entry.name === '__tests__') continue;
      out.push(...walkTsFiles(abs, options));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extract every static import/export-from declaration AND every
 * dynamic import-call expression from a source file. See
 * `ImportSpecifier.kind` for the static/dynamic split. Dynamic
 * `import(...)` arguments are captured when they are STRING
 * LITERALS or NO-SUBSTITUTION TEMPLATE LITERALS (backticks with
 * no `${...}`) — both forms are statically knowable. Template
 * expressions WITH substitutions and specifiers built from
 * runtime variables stay out of scope; their values are only
 * known at runtime.
 */
export function extractImports(source: string, filename = 'inline.ts'): ImportSpecifier[] {
  const sf = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    ts.ScriptKind.TS,
  );
  const out: ImportSpecifier[] = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      pushSpecifier(out, sf, node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly), 'static');
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      pushSpecifier(out, sf, node.moduleSpecifier, node.isTypeOnly, 'static');
    }
  });
  visitForDynamicImports(sf, sf, out);
  return out;
}

function visitForDynamicImports(node: ts.Node, sf: ts.SourceFile, sink: ImportSpecifier[]): void {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    // Capture BOTH single/double-quoted string literals AND
    // no-substitution template literals (backticks with no
    // ${...}). Both forms have a statically-known `.text` and
    // can be used to bypass a string-literal-only scan, e.g.
    // `await import(\`@filoz/synapse-sdk\`)`. Template literals
    // WITH substitutions stay out of static scope — they have
    // runtime-dependent specifiers the scanner can't resolve.
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      const { line } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
      sink.push({
        modulePath: arg.text,
        line: line + 1,
        isTypeOnly: false,
        kind: 'dynamic',
      });
    }
  }
  ts.forEachChild(node, (child) => visitForDynamicImports(child, sf, sink));
}

function pushSpecifier(
  sink: ImportSpecifier[],
  sf: ts.SourceFile,
  moduleSpecifier: ts.Expression,
  isTypeOnly: boolean,
  kind: 'static' | 'dynamic',
): void {
  if (!ts.isStringLiteral(moduleSpecifier)) return;
  const { line } = sf.getLineAndCharacterOfPosition(moduleSpecifier.getStart(sf));
  sink.push({ modulePath: moduleSpecifier.text, line: line + 1, isTypeOnly, kind });
}

export function collectForwardViolations(): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const root of FORWARD_SCAN_ROOTS) {
    if (!isDirectory(root)) continue;
    for (const file of walkTsFiles(root, { skipTestDirs: true })) {
      if (FORWARD_ALLOWLIST.has(file)) continue;
      const imports = extractImports(readFileSync(file, 'utf8'), file);
      for (const { modulePath, line } of imports) {
        if (PROVIDER_SPECIFIER_RE.test(modulePath)) {
          violations.push({ file: path.relative(SRC_ROOT, file), line, modulePath });
        }
      }
    }
  }
  return violations;
}

/**
 * Reverse-boundary allowlist of absolute filesystem paths under
 * `src/`. A relative specifier is RESOLVED against the importing
 * file's directory; the resolved path must either land inside
 * `PROVIDER_DIR` (sibling) or appear in this allowlist. Resolving
 * against the importer is what catches the
 * `providers/filecoin/index.ts → '../other-provider.js'` escape
 * that a string-only sibling check would let through.
 */
const SHARED_STORAGE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Adapter contract — the interface `FilecoinRawContentStore` implements.
  path.resolve(SRC_ROOT, 'storage', 'raw-content-store.ts'),
  // Wider storage seams referenced by the retrieval implementation once upload/reconciler land.
  path.resolve(SRC_ROOT, 'storage', 'storage-backend.ts'),
  path.resolve(SRC_ROOT, 'storage', 'raw-content-store-backend-adapter.ts'),
  path.resolve(SRC_ROOT, 'storage', 'store-registry.ts'),
  path.resolve(SRC_ROOT, 'storage', 'storage-backend-registry.ts'),
  path.resolve(SRC_ROOT, 'storage', 'storage-capabilities.ts'),
  path.resolve(SRC_ROOT, 'storage', 'artifact-public-redaction.ts'),
  path.resolve(SRC_ROOT, 'storage', 'provider-metadata-projection.ts'),
  path.resolve(SRC_ROOT, 'storage', 'pointer-uri-allowlist.ts'),
  path.resolve(SRC_ROOT, 'storage', 'raw-content-codec.ts'),
  // Provider-neutral public projector for the document-side wire.
  path.resolve(SRC_ROOT, 'storage', 'filecoin-public-metadata.ts'),
  // Provider-neutral structural-SHAPE gates (PieceCID / IPFS CID)
  // used by the public projector only — the provider boundary uses
  // the live Synapse SDK parser instead (see `piece-cid.ts`).
  path.resolve(SRC_ROOT, 'storage', 'filecoin-cid-validation.ts'),
  // Shared canonical real-PieceCID fixtures consumed by provider-
  // suite tests AND eager-path tests (routes, public projection)
  // so every site asserts against parser-valid PieceCIDs. The
  // file holds pre-computed string constants only; it does NOT
  // pull the Filecoin SDK into eager loaders.
  path.resolve(SRC_ROOT, 'storage', '__tests__', 'filecoin-cid-fixtures.ts'),
  // Sanitization/event seam owned by the provider package.
  path.resolve(SRC_ROOT, 'services', 'filecoin-observability.ts'),
]);

const REVERSE_DENY_PATTERNS: ReadonlyArray<RegExp> = [
  // SDK packages — providers/filecoin must stay in core.
  /^@atomicmemory\//,
];

const NODE_BUILTIN_RE = /^node:/;

/**
 * Vendor packages the Synapse driver is allowed to consume. The
 * boundary's intent is "no app / core code inside
 * `providers/filecoin/*`"; the vendor SDK + viem are the explicit
 * exceptions because they ARE the provider implementation.
 */
const VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  '@filoz/synapse-sdk',
  // The Synapse SDK does not re-export the PieceCID parser from
  // its top-level index; the canonical surface for `asPieceCID`
  // lives in `@filoz/synapse-core/piece` (re-exported via the
  // package's own `./piece` subpath). The provider boundary uses
  // it for write-path PieceCIDv2 validation — see `piece-cid.ts`.
  '@filoz/synapse-core/piece',
  // Phase 4: the optional `ipfs_cid` sidecar slot is gated via
  // `multiformats/cid`'s `CID.parse` (the same primitive
  // `@filoz/synapse-core/piece` is built on, so this is a
  // transitive dep already inside the lazy provider-load graph
  // — adding it here does NOT change the eager-import surface).
  // See `ipfs-cid.ts` for the wrapper. The `bases/base58` and
  // `bases/base32` subpaths are used by Phase-4 canonicalization
  // tests to materialize non-canonical multibase variants of
  // real CIDs without inlining hardcoded `z…` / `B…` strings.
  'multiformats/cid',
  'multiformats/bases/base58',
  'multiformats/bases/base32',
  // Phase 5: the `filecoin_pin` driver consumes the CAR-first
  // upload subpath of the `filecoin-pin` package, plus the IPFS
  // primitives needed to build/parse the CAR. All four packages
  // live in the lazy provider-load graph — they are reachable
  // ONLY via `await import('./providers/filecoin/...')` from
  // `factory.ts`, so listing them here does not change the
  // eager-import surface. None of these are statically imported
  // by production sources: production sources use runtime
  // `await import(VENDOR_*_CONST)` against `const`-stored
  // specifiers, and the upload-options `logger` field is typed
  // `unknown` locally (see `filecoin-pin-vendor.ts:noopLogger`)
  // — so the production type graph never references the `pino`
  // types. `pino` remains on this allowlist only because tests
  // (which run in dev with the optional graph installed) may
  // still construct a typed logger when an SDK upgrade widens
  // the upload-options shape; it is NOT a production type import.
  'filecoin-pin/core/upload',
  '@helia/unixfs',
  '@helia/verified-fetch',
  '@ipld/car',
  'blockstore-core/memory',
  'pino',
  'viem',
  'viem/accounts',
]);

/**
 * Test-time packages used only by the import-boundary test itself
 * (`typescript` for AST parsing). NOT eligible for use in shipping
 * provider code.
 */
const TEST_TIME_PACKAGES: ReadonlySet<string> = new Set(['vitest', 'typescript']);

function resolveRelativeSpecifier(importingFile: string, modulePath: string): string {
  const dir = path.dirname(importingFile);
  const stripped = modulePath.replace(/\.js$/, '');
  const resolved = path.resolve(dir, stripped);
  return resolved.endsWith('.ts') ? resolved : `${resolved}.ts`;
}

function isInsideProviderDir(absPath: string): boolean {
  const prefix = PROVIDER_DIR + path.sep;
  return absPath === PROVIDER_DIR || absPath.startsWith(prefix);
}

/**
 * `TEST_TIME_PACKAGES` (`vitest`, `typescript`) are allowed ONLY
 * for files inside `src/storage/providers/filecoin/__tests__/`.
 * Without this predicate, a production provider file such as
 * `backend.ts` could import `vitest` or `typescript` and the
 * reverse-boundary scan would still classify it as allowed.
 * Production code must never depend on a test-time package.
 */
function isInsideProviderTestsDir(absPath: string): boolean {
  const prefix = PROVIDER_TESTS_DIR + path.sep;
  return absPath === PROVIDER_TESTS_DIR || absPath.startsWith(prefix);
}

export function classifyReverseImport(
  spec: ImportSpecifier,
  importingFile: string,
): 'allow' | 'violation' {
  const m = spec.modulePath;
  if (NODE_BUILTIN_RE.test(m)) return 'allow';
  if (TEST_TIME_PACKAGES.has(m)) {
    // Conditional allowance: a test-time package import is
    // legitimate only when the importing file itself lives in
    // the provider's `__tests__/` subtree. A production
    // provider file (`backend.ts`, `synapse-client.ts`, etc.)
    // importing `vitest` would still pass a naive package-set
    // check, so the predicate gates here.
    if (isInsideProviderTestsDir(importingFile)) return 'allow';
    return 'violation';
  }
  if (VENDOR_PACKAGES.has(m)) return 'allow';
  if (REVERSE_DENY_PATTERNS.some((re) => re.test(m))) return 'violation';
  // Non-relative specifiers reaching this point are bare packages
  // not on the test-time allowlist — reject them.
  if (!m.startsWith('.')) return 'violation';
  // Relative specifier: resolve against the importing file and
  // verify the resolved path either lands inside PROVIDER_DIR
  // (sibling) or matches the explicit shared-storage allowlist.
  const resolved = resolveRelativeSpecifier(importingFile, m);
  if (isInsideProviderDir(resolved)) return 'allow';
  if (SHARED_STORAGE_ALLOWLIST.has(resolved)) return 'allow';
  return 'violation';
}

/** Synthetic provider-root file path used by classifier tests. */
export const FAKE_PROVIDER_ROOT_FILE = path.resolve(PROVIDER_DIR, 'index.ts');
/** Synthetic provider-test file path used by classifier tests. */
export const FAKE_PROVIDER_TEST_FILE = path.resolve(PROVIDER_DIR, '__tests__', 'fake.test.ts');
