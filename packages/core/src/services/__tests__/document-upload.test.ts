/**
 * Phase 5 α/β/β2/γ upload-pipeline integration tests.
 *
 * Drives `uploadRawDocument` against a real DB row + fakes for the
 * adapter + codec. Coverage:
 *   - plaintext content_hash invariant (DB row + UploadRawResult)
 *   - encoded bytes passed to `store.put()` (AES-GCM round-trip)
 *   - internal raw_storage_metadata shape `{ codec, filecoin?,
 *     upload_result }` after Phase β2
 *   - provider-aware final status: filecoin/stored → blob_available,
 *     filecoin/pending → blob_pending, local_fs/stored → blob_stored
 *   - same-hash idempotency short-circuits before β
 *   - different-hash conflict raises 409
 *   - crash recovery: β→β2 (blob_uploading, no URI) → reclaimAndUpload
 *   - crash recovery: β2→γ (blob_uploading, URI present) → finalize
 *     (no re-encode, no re-upload)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
  getRawDocumentById,
} from '../../db/raw-document-repository.js';
import {
  uploadRawDocument,
  UploadDocumentConflictError,
} from '../document-upload.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import { AesGcmRawContentCodec } from '../../storage/codecs/aes-gcm-codec.js';
import type {
  RawContentStore,
  RawContentStoreCapabilities,
  StoredRawContent,
} from '../../storage/raw-content-store.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'phase5-upload-pipeline';
const PAYLOAD = Buffer.from('phase 5 plaintext payload bytes', 'utf8');
const CFG = {
  rawStoragePrefix: 'phase5',
  rawStorageMode: 'managed_blob' as const,
  storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
};

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface FakeStoreOptions {
  provider: string;
  capabilities?: Partial<RawContentStoreCapabilities>;
  putStatus?: 'stored' | 'pending';
  providerMetadata?: Record<string, unknown>;
  cidFor?: (key: string) => string;
}

interface FakeStoreWithCounters extends RawContentStore {
  readonly putBodies: Buffer[];
  readonly putKeys: string[];
  putCalls: number;
}

function makeFakeStore(opts: FakeStoreOptions): FakeStoreWithCounters {
  const cap: RawContentStoreCapabilities = {
    addressing: 'location',
    retrievalConsistency: 'immediate',
    deleteSemantics: 'delete',
    supportsHead: true,
    supportsGet: true,
    ...(opts.capabilities ?? {}),
  };
  const fake: FakeStoreWithCounters = {
    provider: opts.provider,
    capabilities: cap,
    putBodies: [],
    putKeys: [],
    putCalls: 0,
    async put({ key, body }): Promise<StoredRawContent> {
      fake.putCalls += 1;
      fake.putBodies.push(Buffer.from(body));
      fake.putKeys.push(key);
      const cid = opts.cidFor ? opts.cidFor(key) : key;
      return {
        storageUri: `${opts.provider}://${cid}`,
        storageProvider: opts.provider,
        contentHash: sha256Hex(body),
        sizeBytes: body.length,
        status: opts.putStatus ?? 'stored',
        providerMetadata: opts.providerMetadata ?? {},
      };
    },
    async get() { throw new Error('not used'); },
    async head() { return { exists: true, metadata: null }; },
    async delete() { return { deleted: true, semantics: 'deleted' }; },
  };
  return fake;
}

async function seedDoc(externalId: string): Promise<string> {
  const src = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'drive', provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId,
  });
  return reg.document.id;
}

beforeAll(async () => {
  await setupTestSchema(pool);
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

describe('uploadRawDocument — Phase 5 happy path + plaintext invariant', () => {
  it('writes PLAINTEXT content_hash to the DB row even when codec encrypts bytes', async () => {
    const documentId = await seedDoc('plaintext-1');
    const key = Buffer.alloc(32, 7);
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key }],
      activeKeyId: 'v1',
    });
    const store = makeFakeStore({ provider: 'local_fs' });
    const result = await uploadRawDocument(pool, store, codec, CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    const plaintextHash = sha256Hex(PAYLOAD);
    expect(result.contentHash).toBe(plaintextHash);
    expect(result.sizeBytes).toBe(PAYLOAD.length);
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.contentHash).toBe(plaintextHash);
    expect(row?.sizeBytes).toBe(PAYLOAD.length);
  });

  it('passes ENCRYPTED bytes to the adapter (not plaintext)', async () => {
    const documentId = await seedDoc('plaintext-2');
    const key = Buffer.alloc(32, 11);
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key }],
      activeKeyId: 'v1',
    });
    const store = makeFakeStore({ provider: 'local_fs' });
    await uploadRawDocument(pool, store, codec, CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(store.putBodies).toHaveLength(1);
    const ciphertext = store.putBodies[0];
    expect(ciphertext.equals(PAYLOAD)).toBe(false);
    // Ciphertext is the same length as plaintext for AES-GCM stream mode.
    expect(ciphertext.length).toBe(PAYLOAD.length);
  });

  it('writes nested raw_storage_metadata { codec, filecoin, upload_result } after Phase β2', async () => {
    const documentId = await seedDoc('metadata-1');
    const codec = new NoopRawContentCodec();
    const filecoinProviderMetadata = {
      filecoin: {
        onramp: 'storacha',
        ipfs_cid: 'bafy-test',
        piece_cid: null,
        deals: [],
        gateway_url: 'https://w3s.link/ipfs/bafy-test',
        onramp_status: 'pending',
      },
    };
    const store = makeFakeStore({
      provider: 'filecoin',
      capabilities: { addressing: 'content', retrievalConsistency: 'eventual', deleteSemantics: 'tombstone' },
      putStatus: 'pending',
      providerMetadata: filecoinProviderMetadata,
      cidFor: () => 'bafy-test',
    });
    await uploadRawDocument(pool, store, codec, CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    const row = await getRawDocumentById(pool, USER, documentId);
    const meta = row?.rawStorageMetadata as Record<string, unknown>;
    expect(meta.codec).toEqual({ name: 'none', version: 1 });
    expect(meta.filecoin).toEqual(filecoinProviderMetadata.filecoin);
    expect(meta.upload_result).toEqual({ stored_status: 'pending' });
  });
});

describe('uploadRawDocument — provider-aware final status mapping', () => {
  it('filecoin + adapter pending → blob_pending', async () => {
    const documentId = await seedDoc('status-pending');
    const store = makeFakeStore({
      provider: 'filecoin',
      capabilities: { addressing: 'content', retrievalConsistency: 'eventual', deleteSemantics: 'tombstone' },
      putStatus: 'pending',
    });
    const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(result.rawStorageStatus).toBe('blob_pending');
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });

  it('filecoin + adapter stored → blob_available (gateway-confirmed retrievable)', async () => {
    const documentId = await seedDoc('status-available');
    const store = makeFakeStore({
      provider: 'filecoin',
      capabilities: { addressing: 'content', retrievalConsistency: 'eventual', deleteSemantics: 'tombstone' },
      putStatus: 'stored',
    });
    const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(result.rawStorageStatus).toBe('blob_available');
  });

  it('local_fs + adapter stored → blob_stored (immediate provider)', async () => {
    const documentId = await seedDoc('status-stored');
    const store = makeFakeStore({ provider: 'local_fs', putStatus: 'stored' });
    const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(result.rawStorageStatus).toBe('blob_stored');
  });
});

describe('uploadRawDocument — review-fix HIGH 1: blob_uploading w/o URI + different hash = 409', () => {
  it('rev-fix HIGH 1: blob_uploading + storage_uri NULL + different hash → 409 (no take-over)', async () => {
    const documentId = await seedDoc('hijack-1');
    const persistedHash = sha256Hex(PAYLOAD);
    // Simulate Phase α has run for an in-flight upload: row has
    // `blob_uploading` + plaintext hash + size, but NO storage_uri
    // yet (Phase β2 hasn't completed).
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'blob_uploading',
              raw_storage_claim_id = 'in-flight-claim',
              raw_storage_claimed_at = NOW(),
              content_hash = $1,
              size_bytes = $2
        WHERE id = $3`,
      [persistedHash, PAYLOAD.length, documentId],
    );
    const store = makeFakeStore({ provider: 'local_fs', putStatus: 'stored' });
    const differentBytes = Buffer.from('different payload — must not take over the slot');
    await expect(
      uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
        userId: USER, documentId, body: differentBytes,
      }),
    ).rejects.toBeInstanceOf(UploadDocumentConflictError);
    expect(store.putCalls).toBe(0);
    // Row state preserved — the in-flight upload's claim is intact.
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.rawStorageStatus).toBe('blob_uploading');
    expect(row?.rawStorageClaimId).toBe('in-flight-claim');
    expect(row?.contentHash).toBe(persistedHash);
  });
});

describe('uploadRawDocument — review-fix HIGH 2: reclaim clears stale URI/provider/metadata', () => {
  it('rev-fix HIGH 2: raw_storage_failed retry clears stale URI before β; finalize-recovery cannot pick up stale bytes', async () => {
    const documentId = await seedDoc('reclaim-stale-1');
    const plaintextHash = sha256Hex(PAYLOAD);
    // Seed: prior attempt left a stale URI on a failed row. Same
    // hash → classifyIdempotent returns reclaimAndUpload; Phase α
    // MUST clear the stale URI so a crash before β2 can't strand
    // the row in a finalize-recovery window pointing at old bytes.
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'raw_storage_failed',
              storage_mode = 'managed_blob',
              storage_uri = 'local_fs://stale-from-prior-attempt.bin',
              storage_provider = 'local_fs',
              content_hash = $1,
              size_bytes = $2,
              raw_storage_metadata = $3::jsonb,
              raw_storage_pending_since = NOW() - INTERVAL '1 day'
        WHERE id = $4`,
      [
        plaintextHash, PAYLOAD.length,
        JSON.stringify({
          codec: { name: 'none', version: 1 },
          filecoin: { ipfs_cid: 'bafy-stale' },
          upload_result: { stored_status: 'stored' },
        }),
        documentId,
      ],
    );
    const store = makeFakeStore({
      provider: 'local_fs', putStatus: 'stored',
      cidFor: () => 'fresh-cid',
    });
    const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(store.putCalls).toBe(1);
    // The result + DB row must reference the fresh URI, not the stale one.
    expect(result.storageUri).not.toContain('stale-from-prior-attempt');
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.storageUri).not.toContain('stale-from-prior-attempt');
    expect(row?.storageUri).toBe('local_fs://fresh-cid');
    expect(row?.rawStorageStatus).toBe('blob_stored');
    expect(row?.rawStoragePendingSince).toBeNull();
  });

  it('rev-fix HIGH 2: reclaimAndUpload crash before β2 cannot be misclassified as finalize on next retry', async () => {
    const documentId = await seedDoc('reclaim-stale-2');
    const plaintextHash = sha256Hex(PAYLOAD);
    // Same stale-URI seed as above.
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'raw_storage_failed',
              storage_mode = 'managed_blob',
              storage_uri = 'local_fs://stale-from-prior-attempt.bin',
              storage_provider = 'local_fs',
              content_hash = $1,
              size_bytes = $2
        WHERE id = $3`,
      [plaintextHash, PAYLOAD.length, documentId],
    );
    // Drive Phase α only by throwing in `store.put`. The failure path
    // clears the claim back to raw_storage_failed; the stale URI
    // MUST already be NULL'd by Phase α's clear so the row no longer
    // looks like a finalize-recovery candidate.
    const failingStore: RawContentStore = {
      provider: 'local_fs',
      capabilities: {
        addressing: 'location', retrievalConsistency: 'immediate',
        deleteSemantics: 'delete', supportsHead: true, supportsGet: true,
      },
      put: async () => { throw new Error('simulated β failure'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, metadata: null }),
      delete: async () => ({ deleted: false, semantics: 'deleted' }),
    };
    await expect(
      uploadRawDocument(pool, failingStore, new NoopRawContentCodec(), CFG, {
        userId: USER, documentId, body: PAYLOAD,
      }),
    ).rejects.toThrow(/simulated β failure/);
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.storageUri).toBeNull();
    expect(row?.storageProvider).toBeNull();
    expect(row?.rawStorageStatus).toBe('raw_storage_failed');
  });
});

describe('uploadRawDocument — idempotency + conflict', () => {
  it('same-hash retry short-circuits Phase α (no second store.put)', async () => {
    const documentId = await seedDoc('idempotent-1');
    const store = makeFakeStore({ provider: 'local_fs', putStatus: 'stored' });
    await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    const second = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(second.idempotentSkip).toBe(true);
    expect(store.putCalls).toBe(1);
  });

  it('different-hash retry against an occupied slot raises 409 conflict', async () => {
    const documentId = await seedDoc('conflict-1');
    const store = makeFakeStore({ provider: 'local_fs', putStatus: 'stored' });
    await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    await expect(
      uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
        userId: USER, documentId, body: Buffer.from('different bytes'),
      }),
    ).rejects.toBeInstanceOf(UploadDocumentConflictError);
    expect(store.putCalls).toBe(1);
  });
});

describe('uploadRawDocument — crash-resume recovery', () => {
  it('β→β2 crash (blob_uploading, no URI) → reclaimAndUpload runs β + β2 + γ', async () => {
    const documentId = await seedDoc('crash-beta-1');
    // Simulate Phase α succeeded then process died before Phase β2.
    // The row has blob_uploading + claim_id + plaintext hash/size but
    // NO storage_uri.
    const plaintextHash = sha256Hex(PAYLOAD);
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'blob_uploading',
              raw_storage_claim_id = 'old-claim',
              raw_storage_claimed_at = NOW(),
              content_hash = $1,
              size_bytes = $2
        WHERE id = $3`,
      [plaintextHash, PAYLOAD.length, documentId],
    );
    const store = makeFakeStore({ provider: 'local_fs', putStatus: 'stored' });
    const result = await uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    expect(result.rawStorageStatus).toBe('blob_stored');
    expect(store.putCalls).toBe(1);
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.rawStorageStatus).toBe('blob_stored');
    expect(row?.storageUri).not.toBeNull();
  });

  it('β2→γ crash (blob_uploading, URI present) → finalize alone (no encode, no put)', async () => {
    const documentId = await seedDoc('crash-beta2-1');
    const plaintextHash = sha256Hex(PAYLOAD);
    // Simulate Phase β2 succeeded then process died before Phase γ:
    // row has blob_uploading + claim_id + storage_uri durable +
    // raw_storage_metadata.upload_result.stored_status persisted.
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'blob_uploading',
              raw_storage_claim_id = 'old-claim',
              raw_storage_claimed_at = NOW(),
              storage_mode = 'managed_blob',
              storage_uri = 'filecoin://bafy-resume',
              storage_provider = 'filecoin',
              content_hash = $1,
              size_bytes = $2,
              raw_storage_metadata = $3::jsonb
        WHERE id = $4`,
      [
        plaintextHash, PAYLOAD.length,
        JSON.stringify({
          codec: { name: 'none', version: 1 },
          filecoin: { onramp: 'storacha', ipfs_cid: 'bafy-resume' },
          upload_result: { stored_status: 'stored' },
        }),
        documentId,
      ],
    );
    const codec = new NoopRawContentCodec();
    const encodeSpy = vi.spyOn(codec, 'encode');
    const store = makeFakeStore({ provider: 'filecoin', putStatus: 'stored' });
    const result = await uploadRawDocument(pool, store, codec, CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    // Finalize path: no encode, no put — just the status flip.
    expect(encodeSpy).not.toHaveBeenCalled();
    expect(store.putCalls).toBe(0);
    // Provider is filecoin + stored_status='stored' → blob_available.
    expect(result.rawStorageStatus).toBe('blob_available');
    expect(result.storageUri).toBe('filecoin://bafy-resume');
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.rawStorageStatus).toBe('blob_available');
  });
});
