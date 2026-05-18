/**
 * @file Canonical Filecoin storage URI helpers.
 *
 * The plan pins the URI shape at `filecoin://piece/<pieceCid>` —
 * PieceCID-centered identity per the design doc's URI Contract
 * section. No query string, no fragment, no compatibility shim
 * for legacy `ipfs://` rows.
 *
 * Phase 3 hardening: both helpers validate the PieceCID portion
 * using the LIVE Synapse SDK parser (`asPieceCID` from
 * `@filoz/synapse-core/piece`, wrapped in `./piece-cid.js`). A
 * PieceCID that does not round-trip through the SDK's
 * codec-aware parser (CIDv1, raw codec 0x55, multihash 0x1011)
 * is rejected here, BEFORE the URI ever flows to head/get/delete
 * or to the sidecar persister — eliminating the class of bug
 * where a regex-valid-but-codec-invalid CID would be persisted
 * and then fail downstream with a vendor-shaped error. The
 * shared structural regex (`filecoin-cid-validation.ts`) is NOT
 * used here; it lives on the eager-import path and is the
 * narrower belt-and-suspenders gate for the public projection.
 *
 * Errors are typed `FilecoinProviderError` with sanitized codes:
 *
 *   - `invalid_uri` — wrong scheme/host/shape (extra segments,
 *     missing piece host, query, fragment, non-string input).
 *   - `invalid_piece_cid` — shape OK but the trailing CID is
 *     not a valid PieceCIDv2 per the SDK parser.
 *
 * Callers never see a raw `URL` parser stack or vendor-shaped
 * error.
 */

import { FilecoinProviderError } from './errors.js';
import { requirePieceCid } from './piece-cid.js';

const FILECOIN_URI_SCHEME = 'filecoin:' as const;
const FILECOIN_URI_PIECE_HOST = 'piece' as const;
const FILECOIN_URI_PREFIX = `${FILECOIN_URI_SCHEME}//${FILECOIN_URI_PIECE_HOST}/` as const;

/**
 * Format a PieceCID into the canonical AtomicMemory storage URI.
 * Throws `invalid_piece_cid` when the input is not a valid
 * PieceCIDv2 (per the live Synapse SDK parser); throws
 * `invalid_uri` when the input is empty or contains characters
 * that aren't URI-safe. The returned URI carries the SDK's
 * canonical string form of the PieceCID — non-canonical inputs
 * either fail parsing or are normalized here.
 */
export function formatPieceUri(pieceCid: string): string {
  const trimmed = pieceCid.trim();
  if (trimmed.length === 0) {
    throw new FilecoinProviderError(
      'invalid_uri',
      'Cannot format Filecoin URI: PieceCID is empty.',
    );
  }
  if (/\s/.test(trimmed) || /[/?#]/.test(trimmed)) {
    throw new FilecoinProviderError(
      'invalid_uri',
      "PieceCID contains characters that are not URI-safe (whitespace or '/?#').",
    );
  }
  // `requirePieceCid` runs the SDK's `asPieceCID` parser and
  // returns the canonical string form. The error message is
  // sanitized (no value echo) — malformed CIDs may encode
  // adversarial bytes worth keeping out of log streams. The
  // closed-set `errorCode` is the diagnostic surface.
  const canonical = requirePieceCid(trimmed, 'PieceCID input');
  return `${FILECOIN_URI_PREFIX}${canonical}`;
}

/**
 * Parse a `filecoin://piece/<pieceCid>` URI and return the
 * PieceCID in the SDK's canonical string form. Throws
 * `invalid_uri` on a wrong scheme/host/shape; throws
 * `invalid_piece_cid` when the URI shape is correct but the
 * trailing CID is not a valid PieceCIDv2 per the SDK parser.
 */
export function parsePieceUri(uri: string): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new FilecoinProviderError(
      'invalid_uri',
      'Filecoin storage URI is missing or not a string.',
    );
  }
  if (!uri.startsWith(FILECOIN_URI_PREFIX)) {
    throw new FilecoinProviderError(
      'invalid_uri',
      `Filecoin storage URI must start with '${FILECOIN_URI_PREFIX}'.`,
    );
  }
  const remainder = uri.slice(FILECOIN_URI_PREFIX.length);
  if (remainder.length === 0) {
    throw new FilecoinProviderError(
      'invalid_uri',
      `Filecoin storage URI '${FILECOIN_URI_PREFIX}' has no PieceCID.`,
    );
  }
  if (remainder.includes('/') || remainder.includes('?') || remainder.includes('#')) {
    throw new FilecoinProviderError(
      'invalid_uri',
      "Filecoin storage URI must not contain extra segments, query strings, or fragments.",
    );
  }
  return requirePieceCid(remainder, 'storage URI');
}
