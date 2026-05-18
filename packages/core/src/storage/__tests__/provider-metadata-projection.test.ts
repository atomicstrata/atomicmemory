/**
 * @file Tests for the single provider-metadata projection used by
 * both direct storage artifacts and document-backed artifacts.
 *
 * Phase 3/4 contract: CID-shaped identifiers MUST satisfy the
 * shared structural shape gates (`isPieceCid` / `isIpfsCid`)
 * before they surface in the public output. Sentinel strings,
 * legacy `cid` slot values, and adversarial JSONB are silently
 * dropped. Tests below use real / shape-valid synthetics in the
 * positive cases so a future tightening of the shape gates does
 * NOT silently weaken the projector's leak invariants.
 */

import { describe, expect, it } from 'vitest';
import { projectArtifactProviderFields } from '../provider-metadata-projection.js';
import { REAL_PIECE_CID_A } from './filecoin-cid-fixtures.js';

/** Shape-valid synthetic CIDv1 (any IPLD codec); satisfies `isIpfsCid`. */
const VALID_IPFS_CID = 'bafy' + 'a'.repeat(55);
const VALID_CAR_ROOT_CID = 'bafk' + 'a'.repeat(55);

describe('projectArtifactProviderFields — Filecoin happy path', () => {
  it('projects all four allowlisted identifiers when each value passes its shape gate', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: {
        ipfs_cid: VALID_IPFS_CID,
        piece_cid: REAL_PIECE_CID_A,
        car_root_cid: VALID_CAR_ROOT_CID,
        data_set_id: '42',
        // Operator-internal noise the projector must strip:
        onramp: 'storacha',
        deals: [{ deal_id: 'd1', provider: 'f1' }],
        gateway_url: 'https://gateway/ipfs/x?secret=1',
        wallet_address: 'SECRET',
        signed_request: 'SECRET',
      },
    });
    expect(projected).toEqual({
      identifiers: {
        ipfsCid: VALID_IPFS_CID,
        pieceCid: REAL_PIECE_CID_A,
        carRootCid: VALID_CAR_ROOT_CID,
        dataSetId: '42',
      },
      providerDetails: null,
    });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(JSON.stringify(projected)).not.toContain('storacha');
  });
});

describe('projectArtifactProviderFields — Filecoin shape-gate rejections', () => {
  it('drops a malformed ipfs_cid (fails the CIDv1 shape gate)', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: { ipfs_cid: 'bafy', piece_cid: REAL_PIECE_CID_A },
    });
    expect(projected.identifiers).toEqual({ pieceCid: REAL_PIECE_CID_A });
    expect(JSON.stringify(projected)).not.toContain('ipfsCid');
  });

  it('drops a malformed piece_cid (fails the PieceCID shape gate)', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: { ipfs_cid: VALID_IPFS_CID, piece_cid: 'baga' },
    });
    expect(projected.identifiers).toEqual({ ipfsCid: VALID_IPFS_CID });
    expect(JSON.stringify(projected)).not.toContain('pieceCid');
  });

  it('drops a `bafy…`-shaped value planted in the piece_cid slot (CIDv1 shape, not PieceCID)', () => {
    // Adversarial: a CIDv1-shaped IPFS CID planted under the
    // piece_cid key would pass the broader CIDv1 shape gate but
    // fail the PieceCID prefix gate. The projector must reject.
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: { piece_cid: VALID_IPFS_CID },
    });
    expect(projected.identifiers).toEqual({});
  });

  it('drops a malformed car_root_cid', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: { car_root_cid: 'not-a-cid' },
    });
    expect(projected.identifiers).toEqual({});
  });

  it('drops non-string identifier values without throwing', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: {
        ipfs_cid: 42,
        piece_cid: { x: 1 },
        car_root_cid: null,
        data_set_id: [],
      },
    });
    expect(projected.identifiers).toEqual({});
  });
});

describe('projectArtifactProviderFields — legacy `cid` slot is dropped (Phase 4 greenfield rule)', () => {
  it('drops a legacy filecoin.cid slot — only `ipfs_cid` is consulted now', () => {
    const projected = projectArtifactProviderFields('filecoin', {
      filecoin: { cid: VALID_IPFS_CID, piece_cid: REAL_PIECE_CID_A },
    });
    expect(projected.identifiers).toEqual({ pieceCid: REAL_PIECE_CID_A });
    expect(JSON.stringify(projected)).not.toContain(VALID_IPFS_CID);
    expect(JSON.stringify(projected)).not.toContain('ipfsCid');
  });
});

describe('projectArtifactProviderFields — fail-closed envelope', () => {
  it('returns empty identifiers for unknown providers', () => {
    expect(projectArtifactProviderFields('mystery', { mystery: { ipfs_cid: VALID_IPFS_CID } }))
      .toEqual({ identifiers: {}, providerDetails: null });
  });

  it('returns empty identifiers when the filecoin sibling is malformed', () => {
    expect(projectArtifactProviderFields('filecoin', { filecoin: 'wrong' }))
      .toEqual({ identifiers: {}, providerDetails: null });
    expect(projectArtifactProviderFields('filecoin', { filecoin: null }))
      .toEqual({ identifiers: {}, providerDetails: null });
    expect(projectArtifactProviderFields('filecoin', { filecoin: [1, 2] }))
      .toEqual({ identifiers: {}, providerDetails: null });
  });
});
