/**
 * Concurrency coverage for `uploadRawDocument`.
 *
 * The main upload-pipeline test file is already large, so this file
 * focuses only on the driver-independent race behavior around Phase
 * alpha's document slot claim. It uses a deterministic blocked fake
 * store instead of sleeps: the first upload pauses inside `put()`,
 * then the competing request runs while the row is durably
 * `blob_uploading`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById, registerRawDocument, upsertRawSource } from '../../db/raw-document-repository.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import type { RawContentStore, RawContentStoreCapabilities, StoredRawContent } from '../../storage/raw-content-store.js';
import { uploadRawDocument, UploadDocumentConflictError } from '../document-upload.js';

const USER = 'upload-concurrency-user';
const PAYLOAD = Buffer.from('first concurrent payload');
const OTHER_PAYLOAD = Buffer.from('different concurrent payload');
const CFG = {
  rawStoragePrefix: 'concurrency',
  rawStorageMode: 'managed_blob' as const,
  storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
};

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

describe('uploadRawDocument — concurrent callers for one document', () => {
  it('rejects a different-hash concurrent upload while the first upload owns the slot', async () => {
    const documentId = await seedDoc('different-hash-in-flight');
    const gate = deferred<void>();
    const firstPutEntered = deferred<void>();
    const store = makeBlockingStore(firstPutEntered.resolve, gate.promise);

    const first = uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
      userId: USER, documentId, body: PAYLOAD,
    });
    await firstPutEntered.promise;

    await expect(
      uploadRawDocument(pool, store, new NoopRawContentCodec(), CFG, {
        userId: USER, documentId, body: OTHER_PAYLOAD,
      }),
    ).rejects.toBeInstanceOf(UploadDocumentConflictError);

    gate.resolve();
    await expect(first).resolves.toMatchObject({ rawStorageStatus: 'blob_stored' });
    expect(store.putCalls).toBe(1);
    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.contentHash).toBe(sha256Hex(PAYLOAD));
  });
});

function makeBlockingStore(onFirstPut: () => void, releaseFirst: Promise<void>): RawContentStore & { putCalls: number } {
  const capabilities: RawContentStoreCapabilities = {
    addressing: 'location',
    retrievalConsistency: 'immediate',
    deleteSemantics: 'delete',
    supportsHead: true,
    supportsGet: true,
  };
  return {
    provider: 'local_fs',
    capabilities,
    putCalls: 0,
    async put({ key, body }): Promise<StoredRawContent> {
      this.putCalls += 1;
      onFirstPut();
      await releaseFirst;
      return {
        storageUri: `local_fs://${key}`,
        storageProvider: 'local_fs',
        contentHash: sha256Hex(body),
        sizeBytes: body.length,
        status: 'stored',
        providerMetadata: {},
      };
    },
    async get() { throw new Error('not used'); },
    async head() { return { exists: true, metadata: null }; },
    async delete() { return { deleted: true, semantics: 'deleted' }; },
  };
}

async function seedDoc(externalId: string): Promise<string> {
  const src = await upsertRawSource(pool, {
    userId: USER,
    sourceSite: 'drive',
    provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER,
    rawSourceId: src.id,
    externalId,
  });
  return reg.document.id;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
