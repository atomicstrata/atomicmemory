/**
 * @file Provider-metadata projection for storage artifact rows.
 *
 * Raw-content adapters keep provider-native metadata in their own
 * nested internal shape. Storage artifacts split that into two
 * public columns: discoverable identifiers and provider details.
 * This module is the single translation point so document-backed
 * artifacts and direct storage artifacts expose the same
 * allowlisted shape, and is consumed by `redactArtifactPublic` to
 * build the public `storage_artifacts` wire response.
 *
 * Phase 3/4 contract: CID-shaped identifiers MUST satisfy the
 * shared structural shape gates in `./filecoin-cid-validation.ts`
 * before they may surface in the public output. The projector
 * silently drops anything that fails the shape — so legacy /
 * adversarial / manually-planted JSONB values (the Phase 4
 * rename's pre-migration `cid` slot, sentinel strings, garbage)
 * cannot reach the wire even on rows the SDK parser never gated.
 * Codec-aware validation (Synapse SDK `asPieceCID`,
 * `multiformats/cid.CID.parse`) lives at the WRITE path on the
 * provider boundary; this module stays eager-import safe.
 */

import { isIpfsCid, isPieceCid } from './filecoin-cid-validation.js';

export interface ProjectedArtifactProviderFields {
  identifiers: Record<string, string>;
  providerDetails: Record<string, unknown> | null;
}

export function projectArtifactProviderFields(
  provider: string,
  metadata: Record<string, unknown>,
): ProjectedArtifactProviderFields {
  if (provider === 'filecoin') return projectFilecoin(metadata);
  return { identifiers: {}, providerDetails: null };
}

function projectFilecoin(metadata: Record<string, unknown>): ProjectedArtifactProviderFields {
  const filecoin = nestedRecord(metadata, 'filecoin');
  if (filecoin === null) return { identifiers: {}, providerDetails: null };
  const identifiers: Record<string, string> = {};
  // Phase 4: internal sidecar key is `ipfs_cid` (the legacy
  // ambiguous `cid` slot is silently dropped here AND rejected by
  // the public Zod schema). `car_root_cid` shares the broader
  // CIDv1 shape gate — CAR roots are CIDv1 strings.
  const ipfsCid = filecoin['ipfs_cid'];
  if (isIpfsCid(ipfsCid)) identifiers.ipfsCid = ipfsCid;
  const pieceCid = filecoin['piece_cid'];
  if (isPieceCid(pieceCid)) identifiers.pieceCid = pieceCid;
  const carRootCid = filecoin['car_root_cid'];
  if (isIpfsCid(carRootCid)) identifiers.carRootCid = carRootCid;
  // `data_set_id` is intentionally exposed as a non-empty string
  // — the artifact-identifier wire surfaces the per-row Synapse
  // data-set scalar for operators that need to correlate with
  // their own provider tooling. No CID shape applies.
  const dataSetId = filecoin['data_set_id'];
  if (typeof dataSetId === 'string' && dataSetId.length > 0) {
    identifiers.dataSetId = dataSetId;
  }
  return {
    identifiers,
    // No public providerDetails for filecoin until the provider
    // has explicitly projected Synapse-shaped public fields. The
    // public wire carries CIDs (plus `dataSetId`) only.
    providerDetails: null,
  };
}

function nestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
