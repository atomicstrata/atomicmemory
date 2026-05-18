/**
 * @file Provider-local retriever interface — the seam between
 * the Filecoin provider client and an alternative retrieval
 * backend (e.g. `@helia/verified-fetch`).
 *
 * Phase 6 of the harvest plan adds verified-fetch as an
 * experimental retriever, sitting BEHIND the Filecoin provider
 * boundary rather than the generic storage interface. Doing so
 * lets us evaluate retrieval semantics without exposing a
 * Filecoin-specific public API or letting `provider_details`
 * JSONB drive arbitrary URL fetches.
 *
 * Security contract — every implementer MUST uphold:
 *
 *   1. **CID, not URL.** `get`'s input is a parsed `CID`
 *      (`multiformats/cid`), never a string URL. The
 *      implementation constructs the canonical
 *      `ipfs://<canonicalCidString>` form internally. Callers
 *      cannot pass an arbitrary URL — the type system rejects
 *      it.
 *
 *   2. **CID source provenance.** The `CID` argument MUST come
 *      from one of: the upload pipeline's just-computed root,
 *      a validated provider-client result, or a value that has
 *      already been validated via the SDK parser. Values read
 *      directly from `raw_storage_metadata` / `provider_details`
 *      JSONB are NEVER acceptable input — the parse-and-validate
 *      step must happen at the provider boundary first.
 *
 *   3. **Bounded lifecycle.** The retrieval respects
 *      `options.timeoutMs` via an `AbortSignal`. The
 *      implementation MUST clean up the underlying fetch handle
 *      (`stop()` / similar) on every code path — success,
 *      timeout, error — and MUST NOT leak network/event-loop
 *      resources.
 *
 *   4. **Sanitized errors.** Failures throw
 *      `FilecoinProviderError` with a closed `errorCode` literal.
 *      Raw vendor messages, stack traces, gateway URLs, peer
 *      IDs, multiaddrs, and IP addresses NEVER cross the
 *      boundary — only the documented stable codes:
 *        - `verified_fetch_failed` — generic vendor / retrieval
 *          failure (status ≥ 400 except 404; vendor throw).
 *        - `verified_fetch_timeout` — bounded lifecycle fired
 *          before completion.
 *        - `verified_fetch_not_found` — content not located on
 *          the IPFS network (HTTP 404).
 *        - `verified_fetch_unsupported` — the optional vendor
 *          package (or a transitive dep) is not installed; the
 *          retriever is unavailable in this build.
 *        - `verified_fetch_invalid_cid` — the supplied argument
 *          did not parse as a CID via `CID.parse`. Surfaced when
 *          a caller bypasses the TS signature.
 *        - `verified_fetch_body_too_large` — response body
 *          exceeded the configured `maxBodyBytes` ceiling.
 *
 *   5. **No credentials / private-IP exposure.** No private keys,
 *      wallet addresses, payment-rail details, or
 *      local/loopback addresses leak. The implementation MUST
 *      disable any vendor option that would connect over
 *      private/loopback networks by default.
 */

import type { CID } from 'multiformats/cid';

export interface RetrieverGetOptions {
  /** Per-call timeout in ms; the retriever wires this to an `AbortSignal`. */
  readonly timeoutMs?: number;
}

export interface RetrieverGetResult {
  /** Plaintext bytes addressed by the supplied CID. */
  readonly body: Buffer;
  /** Canonical multibase string form of the retrieved CID. */
  readonly ipfsCid: string;
}

export interface FilecoinRetriever {
  /**
   * Retrieve the bytes addressed by `ipfsCid`. The CID MUST
   * come from a validated provider-client result or the
   * same-upload computed root — see the file header's security
   * contract.
   */
  get(ipfsCid: CID, options?: RetrieverGetOptions): Promise<RetrieverGetResult>;
}
