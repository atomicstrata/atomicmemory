/**
 * @file Verified-fetch retriever — Phase 6 experimental
 * `FilecoinRetriever` implementation backed by
 * `@helia/verified-fetch`.
 *
 * The retriever takes a parsed `CID` (never a URL) and
 * constructs the canonical `ipfs://<cid>` form internally before
 * handing it to verified-fetch. This is the only path through
 * which an `ipfs://` URL is ever assembled inside core; the
 * type system + the `requireParsedCid` guard (which re-parses
 * via `CID.parse`) reject any other input shape. The full
 * security contract is in `retriever.ts`'s file header.
 *
 * File split (lifecycle helpers + vendor seam are siblings):
 *
 *   - `verified-fetch-vendor.ts` — vendor minimal types +
 *     `loadAndCreateVerifiedFetch` (sanitised import + create
 *     boundary, maps `ERR_MODULE_NOT_FOUND` →
 *     `verified_fetch_unsupported`, vendor throws →
 *     `verified_fetch_failed`).
 *   - `verified-fetch-lifecycle.ts` — `startLifecycle`,
 *     `runBoundedRetrieval`, body-reading helpers,
 *     `requireParsedCid`, `mapVerifiedFetchFailure`.
 *   - This file — the `FilecoinRetriever`-implementing class.
 *
 * Source-build invariant. The production build path
 * (`tsc -p tsconfig.build.json` / `npm run build`) compiles
 * WITHOUT the `optionalDependencies` graph present. The
 * vendor module is reached only via a runtime
 * `await import(VENDOR_VERIFIED_FETCH)` inside
 * `verified-fetch-vendor.ts`; no production source statically
 * imports `@helia/verified-fetch`.
 *
 * Lifecycle. Every `get` call creates a fresh fetch handle,
 * awaits the response inside one `Promise.race` against the
 * timeout sentinel, and tears the handle down in `finally`.
 * The implementation never reuses a handle across calls.
 */

import type { CID } from 'multiformats/cid';
import type {
  FilecoinRetriever,
  RetrieverGetOptions,
  RetrieverGetResult,
} from './retriever.js';
import {
  type MinimalVerifiedFetch,
  loadAndCreateVerifiedFetch,
} from './verified-fetch-vendor.js';
import {
  mapVerifiedFetchFailure,
  requireParsedCid,
  runBoundedRetrieval,
  startLifecycle,
} from './verified-fetch-lifecycle.js';

/** Upper bound on what we'll consume from a single retrieval response. */
const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

export interface VerifiedFetchRetrieverOptions {
  /**
   * Bytes ceiling for a single retrieval. Defaults to 100 MiB —
   * roughly the largest object AtomicMemory has reason to fetch
   * from IPFS today. Set lower in tests or in operator
   * deployments with stricter memory budgets.
   */
  readonly maxBodyBytes?: number;
}

export class VerifiedFetchRetriever implements FilecoinRetriever {
  private readonly maxBodyBytes: number;

  constructor(options: VerifiedFetchRetrieverOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async get(ipfsCid: CID, options: RetrieverGetOptions = {}): Promise<RetrieverGetResult> {
    const canonical = requireParsedCid(ipfsCid);
    const url = `ipfs://${canonical}`;
    const lifecycle = startLifecycle(options.timeoutMs);
    let fetch: MinimalVerifiedFetch | null = null;
    try {
      fetch = await loadAndCreateVerifiedFetch();
      const bytes = await runBoundedRetrieval({
        fetch, url, maxBytes: this.maxBodyBytes,
        signal: lifecycle.aborter?.signal,
        timeoutRejection: lifecycle.timeoutRejection,
      });
      return { body: bytes, ipfsCid: canonical };
    } catch (err) {
      throw mapVerifiedFetchFailure(err, lifecycle.aborter, options.timeoutMs);
    } finally {
      lifecycle.cancel();
      // Tear the verified-fetch handle down on every path. Swallow
      // any cleanup error so the original failure (if any) is
      // what surfaces to the caller.
      if (fetch !== null) {
        try {
          await fetch.stop();
        } catch {
          // intentionally suppressed — cleanup must not mask the
          // primary error.
        }
      }
    }
  }
}
