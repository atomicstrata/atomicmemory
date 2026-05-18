/**
 * raw-content blob-deletion tests — direct `DocumentService.delete()` paths.
 *
 * Covers:
 *   - The post-commit `raw_storage_failed` marker on cleanup failure.
 *   - Direct delete happy path (blob removed, marker flips to
 *     `blob_deleted`).
 *   - Idempotent direct delete (no re-cleanup once terminal).
 *   - Retry semantics on a `raw_storage_failed` row: failing → retry
 *     with broken store still throws → retry with healthy store
 *     recovers → terminal pass is a no-op.
 *   - Null-store contract (cleanup failure when the deployment is
 *     misconfigured) and per-blob failure surfacing.
 *
 * Source-reset / wipe-all paths live in
 * `blob-deletion-source-reset.test.ts` to keep this file under the
 * workspace 400-LOC test cap.
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
import { cleanupManagedBlobs } from '../cleanup.js';
import { singleStoreRegistry } from '../store-registry.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'phase3-blob-cleanup-direct';
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
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-blob-del-direct-'));
  store = new LocalFsRawContentStore({ root: storageRoot });
  service = new DocumentService(pool, {
    rawContentStore: store,
    config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
  });
});

afterAll(async () => {
  // Self-cleanup: remove any raw_documents rows this file may have left
  // behind (notably the rows the failure-path tests intentionally leave
  // in `raw_storage_failed` to assert the marker). Without this the
  // next test file's beforeEach would call `repo.deleteAll()` and the
  // strict Phase-3 cleanup path would fail loud against a managed-blob
  // row that has no live store wired.
  await clearDocumentTables(pool);
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

describe('blob deletion — raw_storage_failed marker on cleanup failure', () => {
  it('soft-deleted row is marked raw_storage_failed when post-commit cleanup throws', async () => {
    const { document } = await seedAndUpload('drive', 'mark-fail-1');
    const failingStore = {
      provider: 'local_fs' as const,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error('simulated 5xx'); },
    } as unknown as LocalFsRawContentStore;
    const failingService = new DocumentService(pool, {
      rawContentStore: failingStore,
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(failingService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);
    const row = await pool.query<{ raw_storage_status: string; deleted_at: Date | null }>(
      `SELECT raw_storage_status, deleted_at FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('raw_storage_failed');
    expect(row.rows[0].deleted_at).not.toBeNull();
  });
});

describe('blob deletion — direct document delete', () => {
  it('removes the blob from disk after DocumentService.delete and marks blob_deleted', async () => {
    const { document, upload } = await seedAndUpload('drive', 'direct-1');
    expect(await fileExists(upload.storageUri)).toBe(true);

    const result = await service.delete(USER, document.id);
    expect(result.alreadyDeleted).toBe(false);
    expect(await fileExists(upload.storageUri)).toBe(false);

    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('blob_deleted');
  });

  it('idempotent: a second delete on the same id is a no-op (blob already gone, no re-cleanup)', async () => {
    const { document, upload } = await seedAndUpload('drive', 'direct-2');
    await service.delete(USER, document.id);
    const second = await service.delete(USER, document.id);
    expect(second.alreadyDeleted).toBe(true);
    expect(await fileExists(upload.storageUri)).toBe(false);
  });

  /**
   * Integration: a Filecoin-shaped adapter (tombstone
   * capability + `tombstoned` delete result) drives the row to
   * `blob_tombstoned`, NOT `blob_deleted`. The local_fs upload still
   * happens (so the row has a managed-blob URI in the DB); the
   * registry maps it to a fake `filecoin` adapter at delete time.
   */
  it('Filecoin-shaped adapter (tombstone semantics) marks the row blob_tombstoned on delete', async () => {
    const { document, upload } = await seedAndUpload('drive', 'tombstone-1');
    // Rewrite the row's storage_provider to 'filecoin' so the
    // registry routes the cleanup to the fake filecoin adapter. The
    // bytes are still on the local_fs root; the fake adapter doesn't
    // touch them — it just reports tombstoned semantics so the
    // marker path is exercised end-to-end.
    await pool.query(
      `UPDATE raw_documents SET storage_provider = 'filecoin' WHERE id = $1`,
      [document.id],
    );
    const filecoinFake = {
      provider: 'filecoin' as const,
      capabilities: {
        addressing: 'content' as const,
        retrievalConsistency: 'eventual' as const,
        deleteSemantics: 'tombstone' as const,
        supportsHead: true,
        supportsGet: true,
      },
      put: async () => { throw new Error('not used'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, metadata: null }),
      delete: async () => ({ deleted: true, semantics: 'tombstoned' as const }),
    };
    const filecoinService = new DocumentService(pool, {
      rawContentStore: filecoinFake,
      storeRegistry: singleStoreRegistry(filecoinFake),
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    const result = await filecoinService.delete(USER, document.id);
    expect(result.alreadyDeleted).toBe(false);
    // Local-fs bytes are still on disk because the fake filecoin
    // adapter didn't touch them — this is the right behavior; the
    // tombstone semantic explicitly does NOT promise byte removal.
    expect(await fileExists(upload.storageUri)).toBe(true);
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('blob_tombstoned');
  });

  /**
   * Already-missing Filecoin row still lands `blob_tombstoned` — the
   * cleanup ran, the provider reports `removed: false`, but the
   * adapter's natural semantics (`tombstoned`) drive the terminal
   * state.
   */
  it('Filecoin-shaped adapter with already-missing CID still marks blob_tombstoned', async () => {
    const { document } = await seedAndUpload('drive', 'tombstone-2');
    await pool.query(
      `UPDATE raw_documents SET storage_provider = 'filecoin' WHERE id = $1`,
      [document.id],
    );
    const filecoinFake = {
      provider: 'filecoin' as const,
      capabilities: {
        addressing: 'content' as const,
        retrievalConsistency: 'eventual' as const,
        deleteSemantics: 'tombstone' as const,
        supportsHead: true,
        supportsGet: true,
      },
      put: async () => { throw new Error('not used'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, metadata: null }),
      delete: async () => ({ deleted: false, semantics: 'tombstoned' as const }),
    };
    const filecoinService = new DocumentService(pool, {
      rawContentStore: filecoinFake,
      storeRegistry: singleStoreRegistry(filecoinFake),
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await filecoinService.delete(USER, document.id);
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('blob_tombstoned');
  });

  /**
   * per-row provider dispatch §6 — missing-provider dispatch. A `local-fs://...` row
   * on a Filecoin-only deployment (no legacy registration) hits the
   * registry's "no adapter registered" path and surfaces as a
   * `cleanup failed` error. The row stays `raw_storage_failed` for
   * a future retry.
   */
  it('cleanup on a row whose provider is not registered fails loudly (no silent no-op)', async () => {
    const { document, upload } = await seedAndUpload('drive', 'missing-provider-1');
    await pool.query(
      `UPDATE raw_documents SET storage_provider = 'mystery' WHERE id = $1`,
      [document.id],
    );
    const filecoinOnlyService = new DocumentService(pool, {
      rawContentStore: store,
      storeRegistry: singleStoreRegistry(store),
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(filecoinOnlyService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);
    // Bytes still on disk; row is raw_storage_failed for retry.
    expect(await fileExists(upload.storageUri)).toBe(true);
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [document.id],
    );
    expect(row.rows[0].raw_storage_status).toBe('raw_storage_failed');
  });
});

describe('blob deletion — retry semantics on raw_storage_failed', () => {
  /**
   * Builds a DocumentService whose store throws on `delete()` for the
   * specified URI prefix. Used to drive the failure path in the retry
   * sequence test below.
   */
  function makeServiceWithFailingDelete(): DocumentService {
    const failingStore = {
      provider: 'local_fs' as const,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error('simulated transport error'); },
    } as unknown as LocalFsRawContentStore;
    return new DocumentService(pool, {
      rawContentStore: failingStore,
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
  }

  async function readStatus(documentId: string): Promise<string> {
    const row = await pool.query<{ raw_storage_status: string }>(
      `SELECT raw_storage_status FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    return row.rows[0].raw_storage_status;
  }

  it('first delete throws and leaves the blob + raw_storage_failed; second delete with the same bad store still throws (not success); third delete with a working store cleans up and marks blob_deleted', async () => {
    const { document, upload } = await seedAndUpload('drive', 'retry-sequence');
    const failingService = makeServiceWithFailingDelete();

    // Pass 1: cleanup fails.
    await expect(failingService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);
    expect(await fileExists(upload.storageUri)).toBe(true);
    expect(await readStatus(document.id)).toBe('raw_storage_failed');

    // Pass 2: retry with the same broken store still fails — the
    // service must NOT short-circuit just because the row is already
    // soft-deleted, because the blob is still there.
    await expect(failingService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);
    expect(await fileExists(upload.storageUri)).toBe(true);
    expect(await readStatus(document.id)).toBe('raw_storage_failed');

    // Pass 3: retry with a correctly wired store succeeds, deletes
    // the blob, marks blob_deleted, and reports alreadyDeleted=true.
    const recovered = await service.delete(USER, document.id);
    expect(recovered.alreadyDeleted).toBe(true);
    expect(await fileExists(upload.storageUri)).toBe(false);
    expect(await readStatus(document.id)).toBe('blob_deleted');

    // Pass 4: terminal state — another delete is a true no-op, no
    // cleanup is re-attempted (orphan list is empty).
    const terminal = await service.delete(USER, document.id);
    expect(terminal.alreadyDeleted).toBe(true);
    expect(await readStatus(document.id)).toBe('blob_deleted');
  });

  it('retry with a null store on a raw_storage_failed row also throws (no silent success)', async () => {
    const { document } = await seedAndUpload('drive', 'retry-null');
    const failingService = makeServiceWithFailingDelete();
    await expect(failingService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);

    const noStoreService = new DocumentService(pool, {
      rawContentStore: null,
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(noStoreService.delete(USER, document.id)).rejects.toThrow(/cleanup failed/);
  });
});

describe('blob deletion — null store contract', () => {
  it('cleanup with no registered providers reports failures for every blob (no silent no-op)', async () => {
    const blobs = [
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://orphan-a.bin', rawStorageMetadata: {} },
      { rawDocumentId: 'doc-test', storageProvider: 'local_fs', storageUri: 'local-fs://orphan-b.bin', rawStorageMetadata: {} },
    ];
    const result = await cleanupManagedBlobs(singleStoreRegistry(null), blobs);
    expect(result.attempted).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].message).toMatch(/no \w+ is registered/);
  });

  it('null store + empty blobs is a no-op (no spurious failures)', async () => {
    const result = await cleanupManagedBlobs(singleStoreRegistry(null), []);
    expect(result.failures).toEqual([]);
    expect(result.attempted).toBe(0);
  });

  it('DocumentService.delete on a managed_blob doc with no store throws ManagedBlobCleanupError', async () => {
    // Seed and upload through the real (configured) service so we get a managed_blob row...
    const seeded = await seedAndUpload('webapp-file', 'misconfig-1');
    expect(await fileExists(seeded.upload.storageUri)).toBe(true);

    // ...then call delete through a misconfigured service that has no store wired.
    const misconfigured = new DocumentService(pool, {
      rawContentStore: null,
      config: { rawStoragePrefix: 'phase3', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(misconfigured.delete(USER, seeded.document.id)).rejects.toThrow(/cleanup failed/);
    // Blob is still on disk because the misconfigured service refused to claim success.
    expect(await fileExists(seeded.upload.storageUri)).toBe(true);
  });
});

describe('blob deletion — failure surfacing', () => {
  it('cleanupManagedBlobs collects per-blob errors instead of silently swallowing', async () => {
    const failingStore = {
      provider: 'fake' as const,
      capabilities: {
        addressing: 'location' as const,
        retrievalConsistency: 'immediate' as const,
        deleteSemantics: 'delete' as const,
        supportsHead: true,
        supportsGet: true,
      },
      put: async () => { throw new Error('not used'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, metadata: null }),
      delete: async () => { throw new Error('boom: simulated S3 5xx'); },
    };
    const result = await cleanupManagedBlobs(
      // The interface only constrains shape; cast for the failing stub.
      singleStoreRegistry(failingStore as unknown as LocalFsRawContentStore),
      [
        { rawDocumentId: 'doc-test', storageProvider: 'fake', storageUri: 'fake://a', rawStorageMetadata: {} },
        { rawDocumentId: 'doc-test', storageProvider: 'fake', storageUri: 'fake://b', rawStorageMetadata: {} },
      ],
    );
    expect(result.attempted).toBe(2);
    expect(result.deleted).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].message).toMatch(/simulated S3 5xx/);
  });
});
