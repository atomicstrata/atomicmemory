/**
 * @file Synapse-SDK-backed PieceCID parser for the provider
 * boundary.
 *
 * The shared validator (`src/storage/filecoin-cid-validation.ts`)
 * is intentionally a structural-shape regex with no codec
 * awareness. It exists so the public-projection seam can silently
 * drop adversarial JSONB without dynamically loading the Filecoin
 * SDK at startup (the eager-import path runs even when
 * `RAW_STORAGE_PROVIDER !== 'filecoin'`).
 *
 * The provider boundary is the OPPOSITE trust seam: anything that
 * crosses `parsePieceUri` / `formatPieceUri` /
 * `FilecoinRawContentStore.put` must match the real PieceCIDv2
 * grammar the rest of the Synapse pipeline operates on — CIDv1,
 * raw codec (0x55), multihash code 0x1011
 * (`fr32-sha2-256-trunc254-padded-binary-tree` from
 * `@web3-storage/data-segment`). A string that merely "looks like"
 * a PieceCID but cannot round-trip through the SDK would be
 * persisted only to fail downstream at `head` / `get` / `delete`
 * with a vendor-shaped error that callers can't sanitize.
 *
 * This module sits inside the provider directory and is reached
 * only through the lazy provider-load graph established in Phase
 * 2 — importing it does NOT pull the Synapse SDK into a non-
 * Filecoin-provider startup. The wrapper is intentionally
 * minimal: it just translates the SDK's `asPieceCID(...) | null`
 * contract into a typed `FilecoinProviderError('invalid_piece_cid',
 * ...)` with a sanitized message (no value echo) so callers
 * never surface vendor stack traces.
 */

import { asPieceCID } from '@filoz/synapse-core/piece';
import { FilecoinProviderError } from './errors.js';

/**
 * Returns the SDK's canonical string form of `value` as a
 * PieceCIDv2, or throws `FilecoinProviderError('invalid_piece_cid',
 * ...)` with a sanitized message when the value is not a string,
 * not a parsable CID, or is a CID that does not satisfy
 * `isPieceCID` (codec/multihash/version).
 *
 * Used at trust seams where a malformed value must NOT be
 * persisted (URI parser, URI formatter, upload result mapper).
 * `context` is a short noun-phrase that names the seam the
 * caller is guarding (e.g. `"upload result"`, `"storage URI"`).
 * The value itself is NEVER echoed into the error message —
 * malformed CIDs may encode adversarial bytes worth keeping out
 * of log streams. The closed-set `errorCode` is the diagnostic
 * surface.
 */
export function requirePieceCid(value: unknown, context: string): string {
  if (typeof value === 'string') {
    const parsed = asPieceCID(value);
    if (parsed !== null) return parsed.toString();
  }
  throw new FilecoinProviderError(
    'invalid_piece_cid',
    `Filecoin ${context} carries a value that is not a valid PieceCIDv2.`,
  );
}
