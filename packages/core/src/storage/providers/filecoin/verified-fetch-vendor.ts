/**
 * @file Vendor-boundary helpers for the verified-fetch retriever.
 *
 * Owns the surface that crosses from our code into
 * `@helia/verified-fetch`. The split exists so
 * `verified-fetch-retriever.ts` stays focused on the
 * `FilecoinRetriever` implementation while this file owns the
 * closed minimal type aliases that mirror the bits of the vendor
 * shape we consume, plus the sanitized load + create helpers.
 *
 * Source-build invariant. The production build path
 * (`tsc -p tsconfig.build.json` / `npm run build`) compiles WITHOUT
 * the `optionalDependencies` graph present. Two patterns enforce
 * that here:
 *
 *   1. **Local minimal types.** We do NOT `import type { … }`
 *      from `@helia/verified-fetch`. Every shape we consume is
 *      defined locally so `tsc` never has to resolve the vendor
 *      type declarations.
 *
 *   2. **Non-literal dynamic-import specifier.** The
 *      `await import(...)` call site uses a `VENDOR_*`
 *      `const`-stored specifier. `tsc` does not statically
 *      resolve a non-literal `import(specifier)` argument, so a
 *      synapse-only install
 *      (`npm ci --legacy-peer-deps --omit=optional`) compiles
 *      cleanly even though the optional module is absent.
 *
 * `loadAndCreateVerifiedFetch` is the single sanitisation seam
 * for both the import failure and the construct failure — see
 * `retriever.ts`'s file-header error-code table for the closed
 * mapping.
 */

import { FilecoinProviderError } from './errors.js';

/**
 * Local minimal mirror of the `@helia/verified-fetch` callable
 * surface. The runtime instance is richer; we narrow to the
 * closed set our code actually consumes.
 */
export interface MinimalVerifiedFetch {
  (resource: string, options?: { signal?: AbortSignal }): Promise<Response>;
  stop(): Promise<void>;
}

export interface MinimalCreateVerifiedFetch {
  (init?: { allowLocal?: boolean; allowInsecure?: boolean }): Promise<MinimalVerifiedFetch>;
}

// Specifier stored as a `const` so `tsc` does not statically
// resolve the optional module — same pattern as the Phase 5
// `filecoin-pin-vendor.ts` loaders.
const VENDOR_VERIFIED_FETCH = '@helia/verified-fetch' as const;

async function loadCreateVerifiedFetch(): Promise<MinimalCreateVerifiedFetch> {
  const mod = (await import(VENDOR_VERIFIED_FETCH)) as unknown as {
    createVerifiedFetch: MinimalCreateVerifiedFetch;
  };
  return mod.createVerifiedFetch;
}

/**
 * Load the vendor module AND construct a fetch handle, mapping
 * every failure mode to a sanitized closed `errorCode`:
 *
 *   - Missing optional package (`ERR_MODULE_NOT_FOUND`) →
 *     `verified_fetch_unsupported`. This is the expected failure
 *     on a synapse-only install
 *     (`npm ci --legacy-peer-deps --omit=optional`); operators
 *     surface it through the closed code rather than seeing a
 *     raw `Cannot find module '@helia/verified-fetch'` Node
 *     error.
 *   - Any other load failure → `verified_fetch_failed`.
 *   - Vendor `createVerifiedFetch({...})` throw →
 *     `verified_fetch_failed`. Raw vendor messages do NOT cross
 *     the boundary.
 *
 * Pinned: `allowLocal: false`, `allowInsecure: false`. Vendor
 * defaults today, but pinning prevents a future vendor flip
 * from silently letting us connect to loopback / HTTP gateways.
 */
export async function loadAndCreateVerifiedFetch(): Promise<MinimalVerifiedFetch> {
  let create: MinimalCreateVerifiedFetch;
  try {
    create = await loadCreateVerifiedFetch();
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw new FilecoinProviderError(
        'verified_fetch_unsupported',
        'verified-fetch retriever is unavailable: the @helia/verified-fetch optional package is not installed.',
      );
    }
    throw new FilecoinProviderError(
      'verified_fetch_failed',
      'verified-fetch retriever failed to load.',
    );
  }
  try {
    return await create({ allowLocal: false, allowInsecure: false });
  } catch (err) {
    // Treat `ERR_MODULE_NOT_FOUND` from the construction path
    // the same as from the import itself — both signal a missing
    // (transitive) optional dependency, which is the
    // `verified_fetch_unsupported` outcome operators care about.
    // Any other vendor throw is the generic `verified_fetch_failed`.
    if (isModuleNotFound(err)) {
      throw new FilecoinProviderError(
        'verified_fetch_unsupported',
        'verified-fetch retriever is unavailable: a required optional dependency is not installed.',
      );
    }
    throw new FilecoinProviderError(
      'verified_fetch_failed',
      'verified-fetch retriever failed to initialize.',
    );
  }
}

function isModuleNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}
