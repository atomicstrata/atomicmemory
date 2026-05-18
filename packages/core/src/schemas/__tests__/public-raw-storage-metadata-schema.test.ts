/**
 * @file Strictness tests for `PublicRawStorageMetadataSchema`.
 *
 * Defence-in-depth lock around `formatPublicRawStorageMetadata`. The
 * schema is `.strict()` at every level so any formatter regression
 * that lets an unknown key through fails the response-shape
 * validator at the route boundary.
 *
 * The filecoin sub-object is the Synapse allowlist
 * `{ ipfs_cid, piece_cid, copy_count, provider_ids, copy_statuses }`.
 * The legacy `cid` slot (Phase 4 renamed) and legacy onramp keys
 * (`onramp`, `gateway_url`, `deal_ids`, `onramp_status`,
 * `deal_status`, `retrieval_verified_at`, `last_verified_at`)
 * are explicitly rejected.
 */

import { describe, expect, it } from 'vitest';
import { PublicRawStorageMetadataSchema } from '../document-response-schemas';

describe('PublicRawStorageMetadataSchema — happy path', () => {
  it('accepts the canonical public shape with copies flattened', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        codec: { name: 'aes_gcm', version: 1 },
        filecoin: {
          ipfs_cid: 'bafy-x',
          piece_cid: 'baga-x',
          copy_count: 2,
          provider_ids: ['f01', 'f02'],
          copy_statuses: ['active', 'pending'],
        },
      }).success,
    ).toBe(true);
  });

  it('accepts a filecoin object carrying only identifiers', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { ipfs_cid: 'bafy-x', piece_cid: 'baga-x' },
      }).success,
    ).toBe(true);
  });

  it('accepts an empty object (pointer-only / immediate-provider rows)', () => {
    expect(PublicRawStorageMetadataSchema.safeParse({}).success).toBe(true);
  });

  it('accepts each codec name documented by the public contract', () => {
    for (const codecName of ['none', 'aes_gcm']) {
      expect(
        PublicRawStorageMetadataSchema.safeParse({
          codec: { name: codecName, version: 1 },
        }).success,
      ).toBe(true);
    }
  });
});

describe('PublicRawStorageMetadataSchema — rejects internal sidecars', () => {
  it('rejects top-level upload_result', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        codec: { name: 'none', version: 1 },
        upload_result: { stored_status: 'pending' },
      }).success,
    ).toBe(false);
  });

  it('rejects any unknown top-level field', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        planted_top_level_secret: 'PLANTED',
      }).success,
    ).toBe(false);
  });
});

describe('PublicRawStorageMetadataSchema — rejects AES-GCM internals on codec', () => {
  it.each(['nonce', 'tag', 'key_id', 'encoded_content_hash', 'encoded_size_bytes'])(
    'rejects codec.%s',
    (internalKey) => {
      expect(
        PublicRawStorageMetadataSchema.safeParse({
          codec: { name: 'aes_gcm', version: 1, [internalKey]: 'PLANTED' },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects an unknown codec name (must be 'none' or 'aes_gcm')", () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        codec: { name: 'rot13', version: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('PublicRawStorageMetadataSchema — rejects legacy `cid` slot (Phase 4 rename)', () => {
  it('rejects a Phase-4 legacy filecoin.cid field — the slot is `ipfs_cid` now', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { cid: 'bafy-legacy', piece_cid: 'baga-x' },
      }).success,
    ).toBe(false);
  });
});

describe('PublicRawStorageMetadataSchema — rejects legacy onramp filecoin shape', () => {
  it.each([
    'onramp',
    'gateway_url',
    'deal_ids',
    'onramp_status',
    'deal_status',
    'retrieval_verified_at',
    'last_verified_at',
  ])('rejects legacy filecoin.%s', (legacyKey) => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { ipfs_cid: 'bafy-x', [legacyKey]: 'leaked-value' },
      }).success,
    ).toBe(false);
  });

  it('rejects the internal structured copies[{provider_id,status}] shape', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: {
          ipfs_cid: 'bafy-x',
          copies: [{ provider_id: 'f01', status: 'active' }],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects the internal structured deals[{deal_id,provider}] shape', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { ipfs_cid: 'bafy-x', deals: [{ deal_id: 'd1', provider: 'f01' }] },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown filecoin keys (operator-internal billing secret, reconciler claim id)', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { ipfs_cid: 'bafy-x', internal_billing_secret: 'PLANTED' },
      }).success,
    ).toBe(false);
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        filecoin: { ipfs_cid: 'bafy-x', reconciliation_claim_id: 'leaked-claim' },
      }).success,
    ).toBe(false);
  });
});

describe('PublicRawStorageMetadataSchema — full leak attempt', () => {
  it('rejects an input that mixes EVERY known internal sidecar', () => {
    expect(
      PublicRawStorageMetadataSchema.safeParse({
        codec: {
          name: 'aes_gcm',
          version: 1,
          nonce: 'PLANTED-NONCE',
          tag: 'PLANTED-TAG',
          key_id: 'v1',
          encoded_content_hash: 'planted-hex',
        },
        filecoin: {
          ipfs_cid: 'bafy-end-to-end',
          cid: 'bafy-legacy-rejected',
          copies: [{ provider_id: 'f1', status: 'active' }],
          deals: [{ deal_id: 'd1', provider: 'f1' }],
          onramp: 'storacha',
          gateway_url: 'https://w3s.link/ipfs/x',
          internal_billing_secret: 'PLANTED',
        },
        upload_result: { stored_status: 'pending' },
      }).success,
    ).toBe(false);
  });
});
