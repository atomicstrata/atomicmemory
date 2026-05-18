/**
 * Reconciler `verifyMode: 'hash_verify'` tests.
 * After `head()` returns retrievable, the reconciler must `get()`
 * the bytes, decode through the codec, sha256 the plaintext, and
 * compare to the row's `content_hash` before promoting.
 *
 * The option is supplied directly through `ReconcilerDeps` so the
 * reconciler behavior stays isolated from runtime config wiring.
 *
 * Failure semantics:
 *   - mismatch → `blob_archival_failed` (terminal, no retries).
 *   - get/decode thrown error → still pending (transient).
 *   - `head_only` (default) → no get() call ever.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById } from '../../db/raw-document-repository.js';
import { runOnce } from '../raw-storage-reconciler.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import { AesGcmRawContentCodec } from '../../storage/codecs/aes-gcm-codec.js';
import type {
  RawContentGetResult,
  RawContentHeadResult,
  RawContentStore,
} from '../../storage/raw-content-store.js';
import {
  DEFAULT_DEPS,
  USER,
  headRetrievable,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';

const PLAINTEXT = Buffer.from('phase 6 hash-verify plaintext payload', 'utf8');
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface MockedStoreOpts {
  head: (uri: string) => Promise<RawContentHeadResult>;
  get?: (uri: string) => Promise<RawContentGetResult>;
}

function makeStore(opts: MockedStoreOpts): RawContentStore {
  return {
    provider: 'filecoin',
    capabilities: {
      addressing: 'content', retrievalConsistency: 'eventual',
      deleteSemantics: 'tombstone', supportsHead: true, supportsGet: true,
    },
    put: async () => { throw new Error('not used'); },
    get: opts.get ?? (async () => { throw new Error('get not configured'); }),
    head: opts.head,
    delete: async () => ({ deleted: false, semantics: 'tombstoned' }),
  };
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

describe("verifyMode='head_only' (default)", () => {
  it("never calls store.get() — promotes on head() alone", async () => {
    await seedRow({ externalId: 'head-only-1', contentHash: sha256Hex(PLAINTEXT) });
    const getSpy = vi.fn(async (): Promise<RawContentGetResult> => {
      throw new Error('get should never be called in head_only mode');
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'head_only' as const,
      store: makeStore({ head: headRetrievable, get: getSpy }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.promoted).toBe(1);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("verifyMode='hash_verify' — success path", () => {
  it("calls store.get(), decodes via noop codec, hashes plaintext, promotes on match", async () => {
    const plaintextHash = sha256Hex(PLAINTEXT);
    const id = await seedRow({
      externalId: 'hv-noop-match',
      contentHash: plaintextHash,
      rawStorageMetadata: { codec: { name: 'none', version: 1 } },
    });
    const getReturnsPlaintext = async (uri: string): Promise<RawContentGetResult> => ({
      body: PLAINTEXT,
      metadata: {
        contentLength: PLAINTEXT.length,
        contentType: null,
        contentHash: plaintextHash,
        providerMetadata: { filecoin: { gateway_url: uri } },
      },
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec: new NoopRawContentCodec(),
      store: makeStore({ head: headRetrievable, get: getReturnsPlaintext }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.promoted).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
  });

  it("AES-GCM round-trip: encrypted ciphertext on the wire, plaintext hash matches after decode", async () => {
    const key = randomBytes(32);
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key }],
      activeKeyId: 'v1',
    });
    const encoded = await codec.encode({ body: PLAINTEXT });
    const plaintextHash = sha256Hex(PLAINTEXT);
    const id = await seedRow({
      externalId: 'hv-aes-match',
      contentHash: plaintextHash,
      rawStorageMetadata: { codec: encoded.metadata as unknown as Record<string, unknown> },
    });
    const getReturnsCiphertext = async (): Promise<RawContentGetResult> => ({
      body: encoded.body,
      metadata: {
        contentLength: encoded.body.length,
        contentType: null,
        contentHash: sha256Hex(encoded.body),
        providerMetadata: {},
      },
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec,
      store: makeStore({ head: headRetrievable, get: getReturnsCiphertext }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.promoted).toBe(1);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_available');
  });
});

describe("verifyMode='hash_verify' — mismatch is permanent", () => {
  it("decoded plaintext hash != row.content_hash → blob_archival_failed with content_hash_mismatch", async () => {
    const expectedHash = sha256Hex(PLAINTEXT);
    const id = await seedRow({
      externalId: 'hv-mismatch',
      contentHash: expectedHash,
      reconcileAttempts: 0,
      rawStorageMetadata: { codec: { name: 'none', version: 1 } },
    });
    // Gateway returns DIFFERENT bytes — decoded plaintext will hash
    // to a value other than `expectedHash`.
    const evilSubstitute = Buffer.from('evil substitute payload');
    const getReturnsWrongBytes = async (): Promise<RawContentGetResult> => ({
      body: evilSubstitute,
      metadata: {
        contentLength: evilSubstitute.length, contentType: null,
        contentHash: sha256Hex(evilSubstitute), providerMetadata: {},
      },
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec: new NoopRawContentCodec(),
      store: makeStore({ head: headRetrievable, get: getReturnsWrongBytes }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.archivalFailed).toBe(1);
    expect(summary.promoted).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_archival_failed');
    expect(row?.lastError).toMatchObject({
      layer: 'raw_storage',
      code: 'content_hash_mismatch',
    });
    // Permanent failure — does NOT burn retries.
    expect(row?.rawStorageReconcileAttempts).toBe(0);
  });
});

describe("verifyMode='hash_verify' — transient errors stay pending", () => {
  it("store.get() throws → stillPending (transient, increments attempts)", async () => {
    const id = await seedRow({
      externalId: 'hv-get-throws',
      contentHash: sha256Hex(PLAINTEXT),
      reconcileAttempts: 0,
      rawStorageMetadata: { codec: { name: 'none', version: 1 } },
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec: new NoopRawContentCodec(),
      store: makeStore({
        head: headRetrievable,
        get: async () => { throw new Error('gateway 5xx — transient'); },
      }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.stillPending).toBe(1);
    expect(summary.archivalFailed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageReconcileAttempts).toBe(1);
  });

  it("codec.decode() throws (e.g. wrong key) → stillPending, never archived", async () => {
    // Encode with one key, configure reconciler with a DIFFERENT key
    // — `codec.decode()` throws on the auth-tag mismatch. This is
    // treated as TRANSIENT because a missing/wrong codec key is a
    // global configuration issue, not a per-row failure; the
    // operator can fix it without us flipping every pending row to
    // terminal first.
    const realKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const realCodec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: realKey }],
      activeKeyId: 'v1',
    });
    const wrongCodec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: wrongKey }],
      activeKeyId: 'v1',
    });
    const encoded = await realCodec.encode({ body: PLAINTEXT });
    const id = await seedRow({
      externalId: 'hv-codec-error',
      contentHash: sha256Hex(PLAINTEXT),
      reconcileAttempts: 0,
      rawStorageMetadata: { codec: encoded.metadata as unknown as Record<string, unknown> },
    });
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec: wrongCodec,
      store: makeStore({
        head: headRetrievable,
        get: async (): Promise<RawContentGetResult> => ({
          body: encoded.body,
          metadata: {
            contentLength: encoded.body.length, contentType: null,
            contentHash: sha256Hex(encoded.body), providerMetadata: {},
          },
        }),
      }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.stillPending).toBe(1);
    expect(summary.archivalFailed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
    expect(row?.rawStorageReconcileAttempts).toBe(1);
  });

  it("row with null content_hash stays pending (defensive — should not happen in practice)", async () => {
    const id = await seedRow({
      externalId: 'hv-null-hash',
      contentHash: undefined,
      rawStorageMetadata: { codec: { name: 'none', version: 1 } },
    });
    // Force content_hash to NULL after seeding.
    await pool.query(`UPDATE raw_documents SET content_hash = NULL WHERE id = $1`, [id]);
    const customDeps = {
      ...DEFAULT_DEPS,
      verifyMode: 'hash_verify' as const,
      codec: new NoopRawContentCodec(),
      store: makeStore({
        head: headRetrievable,
        get: async (): Promise<RawContentGetResult> => ({
          body: PLAINTEXT,
          metadata: {
            contentLength: PLAINTEXT.length, contentType: null,
            contentHash: null, providerMetadata: {},
          },
        }),
      }),
    };
    const summary = await runOnce(customDeps);
    expect(summary.stillPending).toBe(1);
    expect(summary.archivalFailed).toBe(0);
    const row = await getRawDocumentById(pool, USER, id);
    expect(row?.rawStorageStatus).toBe('blob_pending');
  });
});
