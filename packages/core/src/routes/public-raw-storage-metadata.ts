/**
 * @file Public projection of `raw_documents.raw_storage_metadata`.
 *
 * The upload and reconciler pipeline writes an internal
 * shape `{ codec, filecoin?, upload_result? }` into the JSONB
 * column. This module is the SINGLE wire-side redaction seam:
 * internal sidecars (`upload_result`, AES-GCM `nonce`/`tag`/`key_id`
 * /`encoded_content_hash`/`encoded_size_bytes`) NEVER appear on the
 * wire; the Filecoin sidecar is projected through the shared
 * storage/public metadata module
 * (`src/storage/filecoin-public-metadata.ts`) so document and
 * storage_artifact paths emit one consistent shape without
 * importing `providers/filecoin/*` from the route layer.
 *
 * The Filecoin public shape is `{ ipfs_cid, piece_cid,
 * copy_count, provider_ids, copy_statuses }` (Phase 4 renamed
 * the previous ambiguous `cid` slot to `ipfs_cid`). Legacy
 * onramp keys (`onramp`, `gateway_url`, `deal_ids`,
 * `onramp_status`, `deal_status`, `retrieval_verified_at`,
 * `last_verified_at`) and the legacy `cid` slot are NOT emitted
 * by this projector — adversarial / pre-migration values are
 * silently dropped at the shape gate (and rejected at the
 * deny-by-default Zod schema if they somehow reach the response
 * validator).
 */

import {
  projectFilecoinPublicMetadata,
  type FilecoinPublicMetadata,
} from '../storage/filecoin-public-metadata.js';

/** Public-facing codec shape — `name` + `version` only. */
export interface PublicCodecMetadata {
  name: string;
  version: number;
}

/**
 * Re-export of the Synapse-shaped public filecoin shape produced
 * by `src/storage/filecoin-public-metadata.ts`. Routes consume
 * the projected fields directly (e.g. `metadata.filecoin?.ipfs_cid`,
 * `metadata.filecoin?.piece_cid`) — see that module for the
 * canonical key list.
 */
export type PublicFilecoinMetadata = FilecoinPublicMetadata;

export interface PublicRawStorageMetadata {
  codec?: PublicCodecMetadata;
  filecoin?: PublicFilecoinMetadata;
}

/**
 * Strip internal-only sidecars from a `raw_storage_metadata` JSONB
 * blob. Pure projection — idempotent and side-effect free.
 *
 *   - `codec` keeps only `{ name, version }`.
 *   - `filecoin` is projected via `projectFilecoinPublicMetadata`
 *     so the wire shape matches the storage-side allowlist.
 *   - `upload_result` and any other top-level
 *     keys are dropped.
 */
export function formatPublicRawStorageMetadata(
  internal: Record<string, unknown>,
): PublicRawStorageMetadata {
  const out: PublicRawStorageMetadata = {};
  const codec = projectCodec(internal['codec']);
  if (codec) out.codec = codec;
  const filecoin = projectFilecoinPublicMetadata(internal['filecoin']);
  if (Object.keys(filecoin).length > 0) out.filecoin = filecoin;
  return out;
}

function projectCodec(value: unknown): PublicCodecMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const version = record['version'];
  if (typeof name !== 'string' || typeof version !== 'number') return null;
  return { name, version };
}
