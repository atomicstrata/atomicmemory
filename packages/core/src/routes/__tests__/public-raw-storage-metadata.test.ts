/**
 * @file Tests for `formatPublicRawStorageMetadata`.
 *
 * The formatter is the single redaction seam between the internal
 * `raw_documents.raw_storage_metadata` JSONB column and the wire
 * shape. The schema validator
 * (`PublicRawStorageMetadataSchema`) is the deny-by-default lock.
 *
 * The filecoin public projection matches the storage-side
 * allowlist — `{ ipfs_cid?, piece_cid?, copy_count, provider_ids,
 * copy_statuses }` (Phase 4 renamed the legacy ambiguous `cid`
 * slot to `ipfs_cid`). Legacy onramp fields (`onramp`,
 * `gateway_url`, `deal_ids`, etc.) and the legacy `cid` slot are
 * NEVER emitted by this formatter — adversarial / pre-migration
 * values are dropped at the shape gate and rejected by the
 * deny-by-default Zod schema.
 */

import { describe, it, expect } from 'vitest';
import { formatPublicRawStorageMetadata } from '../public-raw-storage-metadata.js';
import { PublicRawStorageMetadataSchema } from '../../schemas/document-response-schemas.js';
import { REAL_PIECE_CID_A } from '../../storage/__tests__/filecoin-cid-fixtures.js';

// Phase 3 hardened: the public projection applies the shared
// structural shape gate (`isIpfsCid` / `isPieceCid` in
// `src/storage/filecoin-cid-validation.ts`). The gate is
// intentionally codec-blind; real PieceCIDv2 parsing happens at
// the provider boundary. The PieceCID below is a real parser-
// valid value from the shared fixture so the suite stays
// self-consistent with the write-path tests.
const VALID_IPFS_CID = 'bafy' + 'a'.repeat(55);
const VALID_PIECE_CID = REAL_PIECE_CID_A;

describe('formatPublicRawStorageMetadata — codec redaction', () => {
  it('keeps only name + version on codec; strips AES-GCM internals', () => {
    const result = formatPublicRawStorageMetadata({
      codec: {
        name: 'aes_gcm',
        version: 1,
        nonce: 'planted-nonce-base64url',
        tag: 'planted-tag-base64url',
        key_id: 'v1',
        encoded_content_hash: 'planted-hash',
        encoded_size_bytes: 9999,
      },
    });
    expect(result.codec).toEqual({ name: 'aes_gcm', version: 1 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('planted-nonce-base64url');
    expect(serialized).not.toContain('planted-tag-base64url');
    expect(serialized).not.toContain('planted-hash');
    expect(serialized).not.toContain('9999');
  });

  it('returns no codec field when malformed (missing name or version)', () => {
    expect(formatPublicRawStorageMetadata({ codec: { name: 'aes_gcm' } }).codec).toBeUndefined();
    expect(formatPublicRawStorageMetadata({ codec: 'wrong-type' }).codec).toBeUndefined();
    expect(formatPublicRawStorageMetadata({}).codec).toBeUndefined();
  });
});

describe('formatPublicRawStorageMetadata — upload_result is never emitted', () => {
  it('strips the internal upload sidecar from the wire shape', () => {
    const result = formatPublicRawStorageMetadata({
      codec: { name: 'none', version: 1 },
      upload_result: { stored_status: 'pending' },
    });
    expect(result).toEqual({ codec: { name: 'none', version: 1 } });
    expect(JSON.stringify(result)).not.toContain('upload_result');
    expect(JSON.stringify(result)).not.toContain('stored_status');
  });

  it('strips upload_result even when the codec field is missing', () => {
    const result = formatPublicRawStorageMetadata({
      upload_result: { stored_status: 'stored' },
    });
    expect(result).toEqual({});
  });
});

describe('formatPublicRawStorageMetadata — Filecoin public projection', () => {
  it('flattens copies[{provider_id,status}] into copy_count / provider_ids / copy_statuses', () => {
    const result = formatPublicRawStorageMetadata({
      filecoin: {
        ipfs_cid: VALID_IPFS_CID,
        piece_cid: VALID_PIECE_CID,
        copies: [
          { provider_id: 'f01', status: 'active' },
          { provider_id: 'f02', status: 'pending' },
        ],
      },
    });
    expect(result.filecoin).toEqual({
      ipfs_cid: VALID_IPFS_CID,
      piece_cid: VALID_PIECE_CID,
      copy_count: 2,
      provider_ids: ['f01', 'f02'],
      copy_statuses: ['active', 'pending'],
    });
  });

  it.each([
    'onramp',
    'gateway_url',
    'deal_ids',
    'onramp_status',
    'deal_status',
    'retrieval_verified_at',
    'last_verified_at',
  ])('drops the legacy filecoin.%s field', (legacyKey) => {
    const result = formatPublicRawStorageMetadata({
      filecoin: { ipfs_cid: VALID_IPFS_CID, [legacyKey]: 'planted-storacha-value' },
    });
    expect(result.filecoin).toEqual({ ipfs_cid: VALID_IPFS_CID });
    expect(JSON.stringify(result)).not.toContain('planted-storacha-value');
  });

  it('drops unknown / structured filecoin keys (operator-internal billing secret, raw vendor blobs)', () => {
    const result = formatPublicRawStorageMetadata({
      filecoin: {
        ipfs_cid: VALID_IPFS_CID,
        internal_billing_secret: 'planted-secret',
        reconciliation_claim_id: 'should-be-stripped',
        synapse_response: { token: 'planted-token' },
        wallet_address: '0xPLANTED',
        deals: [{ deal_id: 'd1', provider: 'f1' }],
      },
    });
    expect(result.filecoin).toEqual({ ipfs_cid: VALID_IPFS_CID });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('planted-secret');
    expect(serialized).not.toContain('planted-token');
    expect(serialized).not.toContain('should-be-stripped');
    expect(serialized).not.toContain('0xPLANTED');
  });

  it('omits the filecoin field entirely when no public content survives projection', () => {
    const result = formatPublicRawStorageMetadata({
      filecoin: { onramp: 'storacha', gateway_url: 'https://w3s.link' },
    });
    expect(result).not.toHaveProperty('filecoin');
  });

  it('reports copy_count even when no provider_ids/statuses survive the entries', () => {
    const result = formatPublicRawStorageMetadata({
      filecoin: { ipfs_cid: VALID_IPFS_CID, copies: [{}, { unrelated: 'x' }] },
    });
    expect(result.filecoin).toEqual({ ipfs_cid: VALID_IPFS_CID, copy_count: 2 });
  });
});

describe('formatPublicRawStorageMetadata — schema lock', () => {
  it('the formatter output is always accepted by PublicRawStorageMetadataSchema', () => {
    // Project a hostile internal blob and re-validate the result
    // against the schema. The formatter MUST produce a shape the
    // schema accepts, even when the input planted unknown keys.
    const result = formatPublicRawStorageMetadata({
      codec: { name: 'aes_gcm', version: 1, nonce: 'PLANTED' },
      filecoin: {
        ipfs_cid: VALID_IPFS_CID,
        piece_cid: VALID_PIECE_CID,
        copies: [{ provider_id: 'f01', status: 'active' }],
        onramp: 'storacha',
        wallet_address: '0xPLANTED',
      },
      upload_result: { stored_status: 'pending' },
    });
    const parsed = PublicRawStorageMetadataSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});
