/**
 * Phase 3 blob-deletion tests — source-reset + wipe-all paths.
 *
 * Covers:
 *   - `MemoryService.resetBySource()` retry semantics on
 *     `raw_storage_failed` (orphan-by-source helper picks up the
 *     soft-deleted rows on retry).
 *   - Partial-success marking: per-URI `blob_deleted` even when other
 *     URIs in the same call fail.
 *   - Source-reset happy path + idempotent re-cleanup.
 *   - `PgMemoryStore.deleteAll()` integrated cleanup, abort-on-failure,
 *     fail-loud-without-store, and the cross-user user-scope guard.
 *
 * Direct `DocumentService.delete()` paths (including null-store and
 * per-blob failure surfacing) live in `blob-deletion-direct.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { DocumentService } from '../../services/document-service.js';
import { LocalFsRawContentStore } from '../local-fs-store.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import { deleteAll } from '../../db/repository-write.js';
import { deleteBySource } from '../../db/repository-document-delete.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import { ClaimRepository } from '../../db/claim-repository.js';
import { MemoryService } from '../../services/memory-service.js';
import { PgMemoryStore } from '../../db/pg-memory-store.js';
import { cleanupManagedBlobs } from '../cleanup.js';
import { singleStoreRegistry } from '../store-registry.js';
import type { RawContentStore } from '../raw-content-store.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'phase3-blob-cleanup-source-reset';
const PAYLOAD = Buffer.from('phase 3 blob cleanup test bytes', 'utf8');
let storageRoot: string;
let store: LocalFsRawContentStore;
let service: DocumentService;

async function seedAndUpload(sourceSite: string, externalId: string) {
  const src = await upsertRawSource(pool, { userId: USER, sourceSite, provider: sourceSite });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId,
  });
  const upload = await service.uploadRaw({
    userId: USER, documentId: reg.document.id, body: PAYLOAD,
  });
  return { document: reg.document, upload };
}

async function fileExists(storageUri: string): Promise<boolean> {
  try {
    await stat(join(storageRoot, storageUri.replace('local-fs://', '')));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-blob-del-source-'));
  store = new LocalFsRawContentStore({ root: storageRoot });
  service = new DocumentService(pool, {
    rawContentStore: store,
    config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
  });
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

describe('blob deletion — source-reset retry semantics on raw_storage_failed', () => {
  function makeMemoryService(rawStore: RawContentStore | null): MemoryService {
    const repo = new MemoryRepository(pool, { rawContentStore: rawStore });
    const claimRepo = new ClaimRepository(pool);
    return new MemoryService(
      repo, claimRepo,
      undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
      rawStore,
    );
  }

  function makeFailingStore(): RawContentStore {
    return {
      provider: 'local_fs',
      capabilities: store.capabilities,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error('simulated transport error'); },
    };
  }

  async function readStatus(documentId: string): Promise<string> {
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    return row.rows[0].raw_storage_status;
  }

  it('reset retry sequence: failing store → throws + raw_storage_failed; same bad store again → still throws; recovered store → blob removed + blob_deleted', async () => {
    const seeded = await seedAndUpload('drive', 'reset-retry-1');
    const failing = makeMemoryService(makeFailingStore());

    // Pass 1: fresh source-reset; cleanup fails.
    await expect(failing.resetBySource(USER, 'drive')).rejects.toThrow(/cleanup failed/);
    expect(await fileExists(seeded.upload.storageUri)).toBe(true);
    expect(await readStatus(seeded.document.id)).toBe('raw_storage_failed');

    // Pass 2: retry with the same broken store. The cascade now sees
    // zero active rows; the retry MUST consult the orphan-by-source
    // helper and re-attempt cleanup, then fail loud again.
    await expect(failing.resetBySource(USER, 'drive')).rejects.toThrow(/cleanup failed/);
    expect(await fileExists(seeded.upload.storageUri)).toBe(true);
    expect(await readStatus(seeded.document.id)).toBe('raw_storage_failed');

    // Pass 3: recovered store. Cleanup runs, blob is gone, marker
    // flips to terminal blob_deleted, reset reports success.
    const recovered = makeMemoryService(store);
    await recovered.resetBySource(USER, 'drive');
    expect(await fileExists(seeded.upload.storageUri)).toBe(false);
    expect(await readStatus(seeded.document.id)).toBe('blob_deleted');

    // Pass 4: terminal — no orphan blobs to clean up; reset succeeds.
    await recovered.resetBySource(USER, 'drive');
    expect(await readStatus(seeded.document.id)).toBe('blob_deleted');
  });

  it('partial cleanup: succeeded URIs are marked blob_deleted even when other URIs in the same call fail', async () => {
    const ok = await seedAndUpload('drive', 'partial-ok');
    const bad = await seedAndUpload('drive', 'partial-bad');

    // Store fails delete only for the second URI; the first succeeds.
    const partialStore: RawContentStore = {
      provider: 'local_fs',
      capabilities: store.capabilities,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async (uri: string) => {
        if (uri === bad.upload.storageUri) throw new Error('simulated 5xx');
        return store.delete(uri);
      },
    };
    const partial = makeMemoryService(partialStore);

    await expect(partial.resetBySource(USER, 'drive')).rejects.toThrow(/cleanup failed/);
    // The one that succeeded must NOT be re-tried by a future retry.
    expect(await readStatus(ok.document.id)).toBe('blob_deleted');
    expect(await fileExists(ok.upload.storageUri)).toBe(false);
    // The one that failed stays raw_storage_failed for retry.
    expect(await readStatus(bad.document.id)).toBe('raw_storage_failed');
    expect(await fileExists(bad.upload.storageUri)).toBe(true);

    // Recovery: a healthy store cleans up the still-orphaned bad blob
    // and leaves the already-clean one untouched.
    const recovered = makeMemoryService(store);
    await recovered.resetBySource(USER, 'drive');
    expect(await readStatus(bad.document.id)).toBe('blob_deleted');
    expect(await fileExists(bad.upload.storageUri)).toBe(false);
  });
});

describe('blob deletion — source reset', () => {
  it('deleteBySource returns blob URIs and cleanupManagedBlobs removes them', async () => {
    const a = await seedAndUpload('drive', 'src-1');
    const b = await seedAndUpload('drive', 'src-2');
    const c = await seedAndUpload('webapp-file', 'src-3');

    const result = await deleteBySource(pool, USER, 'drive');
    expect(result.deletedDocuments).toBe(2);
    expect(result.blobs).toHaveLength(2);

    const cleanup = await cleanupManagedBlobs(singleStoreRegistry(store), result.blobs);
    expect(cleanup.deleted).toBe(2);
    expect(cleanup.failures).toEqual([]);
    expect(await fileExists(a.upload.storageUri)).toBe(false);
    expect(await fileExists(b.upload.storageUri)).toBe(false);
    expect(await fileExists(c.upload.storageUri)).toBe(true);
  });

  it('cleanup is idempotent on a re-run (already-missing blobs do not error)', async () => {
    const { upload } = await seedAndUpload('drive', 'src-4');
    const result = await deleteBySource(pool, USER, 'drive');
    await cleanupManagedBlobs(singleStoreRegistry(store), result.blobs);
    const second = await cleanupManagedBlobs(singleStoreRegistry(store), result.blobs);
    expect(second.failures).toEqual([]);
    expect(second.alreadyMissing).toBe(1);
    expect(await fileExists(upload.storageUri)).toBe(false);
  });
});

describe('blob deletion — wipe-all (canonical store-layer path)', () => {
  it('PgMemoryStore.deleteAll(userId) removes every user blob via the integrated path', async () => {
    const a = await seedAndUpload('drive', 'wipe-1');
    const b = await seedAndUpload('webapp-file', 'wipe-2');

    // The store's `deleteAll` internally collects blobs, runs the
    // adapter cleanup, and only hard-deletes the rows when cleanup
    // succeeded. No manual three-step from the caller.
    const memoryStore = new PgMemoryStore(pool, { rawContentStore: store });
    await memoryStore.deleteAll(USER);

    expect(await fileExists(a.upload.storageUri)).toBe(false);
    expect(await fileExists(b.upload.storageUri)).toBe(false);
    const remaining = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM raw_documents WHERE user_id = $1`,
      [USER],
    );
    expect(remaining.rows[0].n).toBe(0);
  });

  it('PgMemoryStore.deleteAll(userId) marks raw_storage_failed and aborts hard-delete on cleanup failure', async () => {
    const { document } = await seedAndUpload('drive', 'wipe-fail-1');

    const failingStore = {
      provider: 'local_fs' as const,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error('simulated transport error'); },
    } as unknown as LocalFsRawContentStore;
    const memoryStore = new PgMemoryStore(pool, { rawContentStore: failingStore });
    await expect(memoryStore.deleteAll(USER)).rejects.toThrow(/cleanup failed/);

    // Row stayed (we did not hard-delete) and is now marked failed.
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('raw_storage_failed');
  });

  it('explicit deleteAll(pool, userId) without a store throws when managed_blob rows exist', async () => {
    await seedAndUpload('drive', 'wipe-no-store');
    // No rawContentStore wired — the cascade must fail loud.
    await expect(deleteAll(pool, USER)).rejects.toThrow(/cleanup failed/);
  });

  it('user-scoped deleteAll failure marks only the requesting user\'s row, not a different user sharing the same storage_uri', async () => {
    // Both users own a row keyed at the same storage_uri. In the wild
    // adapters generate user-namespaced keys, but a duplicate/corrupt
    // URI must never let one user's failed cleanup tombstone another
    // user's still-active row.
    const sharedUri = 'local-fs://phase3/duplicate/cross-user.bin';
    const otherUser = 'phase3-blob-cleanup-other';
    const ownDoc = await seedAndUpload('drive', 'cross-user-own');
    await pool.query(
      `UPDATE raw_documents SET storage_uri = $1, storage_provider = 'local_fs',
                                 storage_mode = 'managed_blob', raw_storage_status = 'blob_stored',
                                 content_hash = 'shared'
        WHERE id = $2`,
      [sharedUri, ownDoc.document.id],
    );

    const otherSrc = await upsertRawSource(pool, { userId: otherUser, sourceSite: 'drive', provider: 'drive' });
    const otherReg = await registerRawDocument(pool, { userId: otherUser, rawSourceId: otherSrc.id, externalId: 'cross-user-other' });
    await pool.query(
      `UPDATE raw_documents SET storage_uri = $1, storage_provider = 'local_fs',
                                 storage_mode = 'managed_blob', raw_storage_status = 'blob_stored',
                                 content_hash = 'shared'
        WHERE id = $2`,
      [sharedUri, otherReg.document.id],
    );

    const failingStore = {
      provider: 'local_fs' as const,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error('simulated transport error'); },
    } as unknown as LocalFsRawContentStore;
    const memoryStore = new PgMemoryStore(pool, { rawContentStore: failingStore });
    await expect(memoryStore.deleteAll(USER)).rejects.toThrow(/cleanup failed/);

    const ownRow = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [ownDoc.document.id],
    );
    const otherRow = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [otherReg.document.id],
    );
    expect(ownRow.rows[0].raw_storage_status).toBe('raw_storage_failed');
    expect(otherRow.rows[0].raw_storage_status).toBe('blob_stored');

    // House-keeping: clear the other user's row so test-file afterAll
    // doesn't leak it across the suite.
    await pool.query(`DELETE FROM raw_documents WHERE user_id = $1`, [otherUser]);
    await pool.query(`DELETE FROM raw_sources WHERE user_id = $1`, [otherUser]);
  });
});
