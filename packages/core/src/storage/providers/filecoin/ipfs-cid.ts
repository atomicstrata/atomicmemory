/**
 * @file IPFS / CAR-root CID parser for the provider boundary.
 *
 * Phase 4 introduces an optional `ipfs_cid` slot on the
 * Filecoin sidecar: a future driver (filecoin-pin) will emit
 * the IPFS / CAR-root identity alongside the canonical PieceCID
 * so consumers that resolve content via IPFS gateways can do so
 * without re-deriving the CID from bytes. Today the live Synapse
 * driver leaves the slot undefined; this parser exists to gate
 * the slot whenever a future driver populates it.
 *
 * The parser uses `multiformats/cid`, which is already inside
 * the lazy provider-load graph (it's a transitive dependency of
 * `@filoz/synapse-core/piece`). Importing it here therefore does
 * NOT change the eager-import surface — non-Filecoin-provider
 * startups still avoid the Filecoin SDK entirely.
 *
 * Codec policy: we accept any CIDv1 (`code` is any IPLD codec,
 * `version === 1`). CIDv0 (`Qm…` base58btc) is rejected — the
 * sidecar slot is a forward-looking field and we do not need to
 * accept the legacy 1.0 shape. The canonical multibase form is
 * `base32-lower` (`b…`); non-canonical encodings (e.g. base58btc
 * `z…`) parse but are returned in their canonical form so the
 * persisted sidecar value is deterministic regardless of how the
 * driver originally serialized it.
 *
 * Sister module — `./piece-cid.ts` performs the same role for
 * PieceCIDv2 via the Synapse SDK's `asPieceCID`. The two parsers
 * are kept separate because the PieceCID parser ALSO enforces
 * codec semantics (raw codec 0x55 + multihash 0x1011), which
 * the IPFS CID slot intentionally does NOT — an IPFS CID may
 * be dag-pb, raw, dag-cbor, etc.
 */

import { CID } from 'multiformats/cid';
import { FilecoinProviderError } from './errors.js';

/**
 * Returns the canonical CIDv1 string form of `value`, or throws
 * `FilecoinProviderError('invalid_ipfs_cid', ...)` with a
 * sanitized message when the value is not a string, is not a
 * parsable CID, or is a CIDv0 (`Qm…`). Promoting a CIDv1 from a
 * non-canonical multibase encoding to its canonical base32-lower
 * `b…` form is done here so callers always get the deterministic
 * persisted shape.
 *
 * `context` is a short noun-phrase that names the seam the
 * caller is guarding (e.g. `"upload result ipfsCid"`). The
 * rejected value itself is NEVER echoed into the error message —
 * malformed CIDs may encode adversarial bytes worth keeping out
 * of log streams. The closed-set `errorCode` is the diagnostic
 * surface.
 */
export function requireIpfsCid(value: unknown, context: string): string {
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = CID.parse(value);
      if (parsed.version === 1) return parsed.toString();
    } catch {
      // Fall through to the sanitized throw below.
    }
  }
  throw new FilecoinProviderError(
    'invalid_ipfs_cid',
    `Filecoin ${context} carries a value that is not a valid CIDv1.`,
  );
}
