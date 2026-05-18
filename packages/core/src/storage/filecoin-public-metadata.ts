/**
 * @file Provider-neutral public projection of the Filecoin
 * `raw_documents.raw_storage_metadata.filecoin` sidecar.
 *
 * Routes, document services, and SDK packages MUST import the
 * public projector from this module — NOT from
 * `src/storage/providers/filecoin/`. The provider directory is the
 * implementation seam (upload allowlist, denylist, provider-client
 * wiring); leaking it through route imports would couple the route
 * layer to the eventual provider package boundary.
 *
 * Mirror rule: the upload-side allowlist + denylist in
 * `providers/filecoin/metadata.ts` is the SOURCE of truth for what
 * fields the upload implementation may stamp on outgoing uploads;
 * this module is the SOURCE of truth for what survives onto the
 * wire when reading those rows back. The two contracts overlap by
 * design (CIDs + copy state) but live in different files so the
 * route layer never has to learn the provider package shape.
 *
 * Synapse public shape:
 *
 *   {
 *     ipfs_cid?: string,
 *     piece_cid?: string,
 *     copy_count?: number,
 *     provider_ids?: string[],
 *     copy_statuses?: string[],
 *   }
 *
 * Phase 4 renamed the legacy ambiguous `cid` slot to `ipfs_cid`
 * — see harvest plan §Phase 4. The slot is optional and only
 * populated by drivers that emit an IPFS / CAR-root identity
 * alongside the PieceCID (today: none; planned: filecoin-pin).
 * The canonical storage URI stays `filecoin://piece/<pieceCid>`
 * regardless of whether `ipfs_cid` is present — IPFS CID is a
 * resolution-hint field, not a row-identity field.
 *
 * The internal `copies: [{ provider_id, status }]` shape is
 * flattened by `projectFilecoinPublicMetadata`; legacy onramp keys
 * (`onramp`, `gateway_url`, `deal_ids`, `onramp_status`, etc.) are
 * NOT emitted by this projector.
 */

import { isIpfsCid, isPieceCid } from './filecoin-cid-validation.js';

export interface FilecoinPublicMetadata {
  readonly ipfs_cid?: string;
  readonly piece_cid?: string;
  readonly copy_count?: number;
  readonly provider_ids?: ReadonlyArray<string>;
  readonly copy_statuses?: ReadonlyArray<string>;
}

/**
 * Reduce the internal Filecoin sidecar to a wire-safe public
 * projection. Returns an empty object when the input is malformed
 * or the projection has no recognised content; callers can drop
 * the empty object from the wire response.
 *
 * Phase 3 hardening: `piece_cid` is gated by the shared codec-
 * blind shape predicate (`isPieceCid` in
 * `./filecoin-cid-validation.ts`) before crossing the public
 * boundary — adversarial / legacy / manually-planted JSONB values
 * that don't match the structural shape are silently dropped
 * rather than echoed onto the wire. The shape gate is a belt-and-
 * suspenders defence; on the WRITE path the provider boundary
 * already rejected anything that doesn't round-trip through the
 * Synapse SDK parser, so for rows written via the normal pipeline
 * this gate is a no-op. The `ipfs_cid` slot uses the broader
 * CIDv1 base32 shape predicate (`isIpfsCid`) — real codec-aware
 * parsing happens on the WRITE path inside
 * `providers/filecoin/ipfs-cid.ts` via `multiformats/cid`. The
 * projector intentionally stays eager-import-safe and vendor-light
 * here, defeating any attempt to leak adversarial JSONB onto the
 * wire even on legacy rows the SDK parser never gated.
 */
export function projectFilecoinPublicMetadata(internal: unknown): FilecoinPublicMetadata {
  if (!isRecord(internal)) return {};
  const out: { -readonly [K in keyof FilecoinPublicMetadata]: FilecoinPublicMetadata[K] } = {};
  if (isIpfsCid(internal['ipfs_cid'])) {
    out.ipfs_cid = internal['ipfs_cid'];
  }
  if (isPieceCid(internal['piece_cid'])) {
    out.piece_cid = internal['piece_cid'];
  }
  const copiesProjection = projectCopies(internal['copies']);
  if (copiesProjection !== null) {
    out.copy_count = copiesProjection.copy_count;
    if (copiesProjection.provider_ids.length > 0) {
      out.provider_ids = copiesProjection.provider_ids;
    }
    if (copiesProjection.copy_statuses.length > 0) {
      out.copy_statuses = copiesProjection.copy_statuses;
    }
  }
  return out;
}

interface CopiesProjection {
  copy_count: number;
  provider_ids: string[];
  copy_statuses: string[];
}

function projectCopies(value: unknown): CopiesProjection | null {
  if (!Array.isArray(value)) return null;
  const provider_ids: string[] = [];
  const copy_statuses: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const providerId = entry['provider_id'];
    if (typeof providerId === 'string' && providerId.length > 0) {
      provider_ids.push(providerId);
    }
    const status = entry['status'];
    if (typeof status === 'string' && status.length > 0) {
      copy_statuses.push(status);
    }
  }
  return { copy_count: value.length, provider_ids, copy_statuses };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
