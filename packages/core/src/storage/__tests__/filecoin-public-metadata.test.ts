/**
 * @file Tests for the provider-neutral `projectFilecoinPublicMetadata`
 * helper. The function lives outside `providers/filecoin/` so route +
 * service consumers can import it without crossing the provider
 * import boundary.
 *
 * Phase 3 hardening: `ipfs_cid` (Phase 4 rename of the legacy
 * `cid` slot) and `piece_cid` are structurally validated via the
 * shared shape gate (`isIpfsCid` / `isPieceCid` in
 * `../filecoin-cid-validation.ts`) before crossing the public
 * boundary. The shape gate is intentionally codec-blind — real
 * codec-aware parsing happens at the provider boundary via the
 * Synapse SDK (`piece-cid.ts`) and `multiformats/cid`
 * (`ipfs-cid.ts`). Tests here use a real PieceCID from the
 * shared fixture so the positive path is honest about what flows
 * through the legitimate write pipeline; the IPFS CID is a
 * synthetic CIDv1 base32 string because the live driver does not
 * emit the field today and the gate is shape-only.
 */

import { describe, expect, it } from 'vitest';
import {
  projectFilecoinPublicMetadata,
} from '../filecoin-public-metadata.js';
import { REAL_PIECE_CID_A } from './filecoin-cid-fixtures.js';

/** Real PieceCIDv2; rounds-trip through `@filoz/synapse-core/piece.asPieceCID`. */
const VALID_PIECE_CID = REAL_PIECE_CID_A;
/** Synthetic CIDv1 shape; the shape gate is intentionally codec-blind. */
const VALID_IPFS_CID = 'bafybei' + 'a'.repeat(52);

describe('projectFilecoinPublicMetadata — defensive shape handling', () => {
  it('returns an empty object for non-object inputs', () => {
    expect(projectFilecoinPublicMetadata(null)).toEqual({});
    expect(projectFilecoinPublicMetadata(undefined)).toEqual({});
    expect(projectFilecoinPublicMetadata('string')).toEqual({});
    expect(projectFilecoinPublicMetadata([1, 2])).toEqual({});
  });

  it('returns {} when the input has no recognised public fields', () => {
    expect(projectFilecoinPublicMetadata({ wallet: 'x', extra: 'y' })).toEqual({});
  });
});

describe('projectFilecoinPublicMetadata — scalar identifiers', () => {
  it('keeps allowlisted scalar identifiers (ipfs_cid, piece_cid)', () => {
    expect(
      projectFilecoinPublicMetadata({
        ipfs_cid: VALID_IPFS_CID,
        piece_cid: VALID_PIECE_CID,
        wallet_address: 'SECRET',
        private_key: 'SECRET',
      }),
    ).toEqual({
      ipfs_cid: VALID_IPFS_CID,
      piece_cid: VALID_PIECE_CID,
    });
  });

  it('drops empty-string scalars', () => {
    expect(
      projectFilecoinPublicMetadata({ ipfs_cid: '', piece_cid: VALID_PIECE_CID }),
    ).toEqual({ piece_cid: VALID_PIECE_CID });
  });

  it('drops a legacy `cid` slot — only the renamed `ipfs_cid` is consulted', () => {
    // Phase 4 renamed the field. A legacy planted `cid` (e.g.
    // from a row written before the rename, or a fixture that
    // wasn't migrated) is now silently dropped — the public
    // schema no longer declares the key, so leaking it would
    // fail the response-shape validator anyway.
    expect(
      projectFilecoinPublicMetadata({ cid: VALID_IPFS_CID, piece_cid: VALID_PIECE_CID }),
    ).toEqual({ piece_cid: VALID_PIECE_CID });
  });
});

describe('projectFilecoinPublicMetadata — copies → flat scalars', () => {
  it('flattens copies[{provider_id,status}] into copy_count / provider_ids / copy_statuses', () => {
    const out = projectFilecoinPublicMetadata({
      ipfs_cid: VALID_IPFS_CID,
      copies: [
        { provider_id: 'f01', status: 'active' },
        { provider_id: 'f02', status: 'pending' },
        { provider_id: 'f03', status: 'terminated' },
      ],
    });
    expect(out).toEqual({
      ipfs_cid: VALID_IPFS_CID,
      copy_count: 3,
      provider_ids: ['f01', 'f02', 'f03'],
      copy_statuses: ['active', 'pending', 'terminated'],
    });
  });

  it('reports copy_count without provider_ids/statuses when the entries lack scalars', () => {
    const out = projectFilecoinPublicMetadata({
      copies: [{}, { unrelated: 'x' }],
    });
    expect(out.copy_count).toBe(2);
    expect(out.provider_ids).toBeUndefined();
    expect(out.copy_statuses).toBeUndefined();
  });
});

describe('projectFilecoinPublicMetadata — secret + legacy leak attempts', () => {
  it('drops unknown / structured top-level fields and never leaks secrets', () => {
    const out = projectFilecoinPublicMetadata({
      ipfs_cid: VALID_IPFS_CID,
      private_key: 'SECRET_KEY',
      wallet_address: 'SECRET_WALLET',
      synapse_response: { token: 'SECRET_TOKEN' },
      nested: { x: 1 },
      arrayish: [1, 2, 3],
    });
    expect(out).toEqual({ ipfs_cid: VALID_IPFS_CID });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it.each([
    'onramp',
    'gateway_url',
    'deal_ids',
    'onramp_status',
    'deal_status',
    'retrieval_verified_at',
    'last_verified_at',
  ])('drops legacy field %s', (legacyKey) => {
    const out = projectFilecoinPublicMetadata({ ipfs_cid: VALID_IPFS_CID, [legacyKey]: 'planted' });
    expect(out).toEqual({ ipfs_cid: VALID_IPFS_CID });
  });
});

describe('projectFilecoinPublicMetadata — Phase 3 CID structural validation', () => {
  it('drops piece_cid when the input is structurally malformed (adversarial JSONB)', () => {
    // Adversarial values planted in `raw_storage_metadata.filecoin.piece_cid`
    // MUST NOT reach the wire. The structural validator silently
    // drops the field; the rest of the projection survives.
    const out = projectFilecoinPublicMetadata({
      piece_cid: 'baga-test-cid', // too short + invalid charset
      copies: [{ provider_id: 'f01', status: 'active' }],
    });
    expect(out.piece_cid).toBeUndefined();
    expect(out.copy_count).toBe(1);
  });

  it('drops piece_cid when the prefix is wrong (looks like an IPFS CID, not a PieceCID)', () => {
    // `bafy...` is a structurally-valid IPFS CIDv1 but NOT a
    // PieceCID — the piece_cid slot must reject it. (Earlier
    // revisions of this test mistakenly used the key
    // `piece_ipfs_cid`, which made the assertion pass
    // vacuously because `piece_cid` was simply absent. The real
    // pin is to plant `VALID_IPFS_CID` IN the `piece_cid` slot
    // and verify the PieceCID shape gate rejects it.)
    const out = projectFilecoinPublicMetadata({ piece_cid: VALID_IPFS_CID });
    expect(out.piece_cid).toBeUndefined();
  });

  it('drops ipfs_cid when the input is not a structurally-valid CIDv1', () => {
    const out = projectFilecoinPublicMetadata({ ipfs_cid: 'not-a-cid' });
    expect(out.ipfs_cid).toBeUndefined();
  });

  it('accepts a PieceCID-shaped value in the ipfs_cid slot (ipfs_cid predicate is generic CIDv1)', () => {
    // `isIpfsCid` is the generic CIDv1 shape; PieceCIDs satisfy
    // it too. The slot doesn't try to assert codec semantics.
    const out = projectFilecoinPublicMetadata({ ipfs_cid: VALID_PIECE_CID });
    expect(out.ipfs_cid).toBe(VALID_PIECE_CID);
  });

  it('drops non-string piece_cid (number, null, object) without throwing', () => {
    expect(projectFilecoinPublicMetadata({ piece_cid: 42 }).piece_cid).toBeUndefined();
    expect(projectFilecoinPublicMetadata({ piece_cid: null }).piece_cid).toBeUndefined();
    expect(projectFilecoinPublicMetadata({ piece_cid: { x: 1 } }).piece_cid).toBeUndefined();
  });
});
