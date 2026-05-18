/**
 * Step 7 of the storage-sibling plan — integration tests for the
 * document-ingestion ↔ storage_artifacts wiring.
 *
 * Covers:
 *   - Registering with `external_uri` creates a paired pointer-mode
 *     artifact and links `raw_documents.storage_artifact_id`.
 *   - Registering without `external_uri` leaves the link NULL.
 *   - Managed upload (local_fs) creates a managed artifact, soft-
 *     deletes any prior pointer artifact, and the sync hook flips
 *     the artifact's `status` in lockstep with the document.
 *   - The reconciler's promote / fail paths drive
 *     `syncArtifactStatusFromRawDocument` to `'available'` /
 *     `'failed'`.
 *   - Cleanup (`runBlobCleanupOrThrow`) flips the artifact to
 *     `'deleted'` for both `local_fs` and tombstoned paths.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
  getRawDocumentById,
} from '../../db/raw-document-repository.js';
import { getStorageArtifactById, getStorageArtifactByIdIncludingDeleted } from '../../db/storage-artifact-repository.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { buildStoreRegistry } from '../../storage/store-registry.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import { DocumentService } from '../document-service.js';
import { syncArtifactStatusFromRawDocument } from '../../db/raw-doc-artifact-sync.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import { useStorageRootFixture } from './storage-service-test-helpers.js';

const USER_A = 'doc-artifact-sync-user-a';
const USER_B = 'doc-artifact-sync-user-b';

let service: DocumentService;
const fixture = useStorageRootFixture('doc-artifact-sync-');

async function makeSource(): Promise<string> {
  const source = await upsertRawSource(pool, {
    userId: USER_A,
    sourceSite: 'drive',
    provider: 'google-drive',
  });
  return source.id;
}

async function registerWithExternalUri(externalId: string): Promise<string> {
  const sourceId = await makeSource();
  const { document } = await registerRawDocument(pool, {
    userId: USER_A,
    rawSourceId: sourceId,
    externalId,
    externalUri: 'https://example.com/file.pdf',
    storageMode: 'pointer_only',
  });
  return document.id;
}

beforeAll(async () => {
  const store = new LocalFsRawContentStore({ root: fixture.storageRoot });
  service = new DocumentService(pool, {
    rawContentStore: store,
    storeRegistry: buildStoreRegistry(store, []),
    codec: new NoopRawContentCodec(),
    config: {
      rawStoragePrefix: 'test',
      rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    },
  });
});

describe('Step 7 — register document with external_uri', () => {
  it('creates a paired pointer artifact and links storage_artifact_id atomically', async () => {
    const docId = await registerWithExternalUri('ext-pointer-1');
    const doc = await getRawDocumentById(pool, USER_A, docId);
    expect(doc!.storageArtifactId).not.toBeNull();
    const artifact = await getStorageArtifactById(pool, USER_A, doc!.storageArtifactId!);
    expect(artifact!.mode).toBe('pointer');
    expect(artifact!.status).toBe('stored');
    expect(artifact!.uri).toBe('https://example.com/file.pdf');
  });

  it('leaves storage_artifact_id NULL when no external_uri is supplied', async () => {
    const sourceId = await makeSource();
    const { document } = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: sourceId,
      externalId: 'ext-stub-1',
      storageMode: 'pointer_only',
    });
    expect(document.storageArtifactId).toBeNull();
  });
});

describe('Step 7 — managed upload swaps the artifact', () => {
  it('soft-deletes the prior pointer artifact and links a new managed artifact', async () => {
    const docId = await registerWithExternalUri('ext-swap-1');
    const before = await getRawDocumentById(pool, USER_A, docId);
    const priorArtifactId = before!.storageArtifactId!;
    await service.uploadRaw({
      documentId: docId,
      userId: USER_A,
      body: Buffer.from('managed-bytes'),
      contentType: 'text/plain',
    });
    const priorArtifact = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, priorArtifactId);
    expect(priorArtifact!.status).toBe('deleted');
    const after = await getRawDocumentById(pool, USER_A, docId);
    expect(after!.storageArtifactId).not.toBe(priorArtifactId);
    const newArtifact = await getStorageArtifactById(pool, USER_A, after!.storageArtifactId!);
    expect(newArtifact!.mode).toBe('managed');
    expect(newArtifact!.status).toBe('stored');
    expect(newArtifact!.provider).toBe('local_fs');
  });
});

describe('Step 7 — sync hook covers reconciler + failure transitions', () => {
  it('drives an artifact through pending → available when the reconciler promotes the document', async () => {
    // Register, get a pointer artifact, then simulate a managed
    // upload that left the document in `blob_pending` (filecoin
    // path) by directly setting the row state. The sync hook on
    // the reconciler's promote path must then flip the artifact
    // to `'available'`.
    const docId = await registerWithExternalUri('ext-reconcile-1');
    await service.uploadRaw({
      documentId: docId,
      userId: USER_A,
      body: Buffer.from('bytes'),
      contentType: 'text/plain',
    });
    const linked = (await getRawDocumentById(pool, USER_A, docId))!.storageArtifactId!;
    await pool.query(
      `UPDATE raw_documents SET raw_storage_status = 'blob_pending' WHERE id = $1`,
      [docId],
    );
    await pool.query(
      `UPDATE storage_artifacts SET status = 'pending' WHERE id = $1`,
      [linked],
    );
    await syncArtifactStatusFromRawDocument(pool, {
      rawDocumentId: docId,
      newRawStatus: 'blob_available',
    });
    const artifact = await getStorageArtifactById(pool, USER_A, linked);
    expect(artifact!.status).toBe('available');
    expect(artifact!.lastError).toBeNull();
  });

  it('flips the artifact to failed and records last_error on archival failure', async () => {
    const docId = await registerWithExternalUri('ext-archival-fail-1');
    await service.uploadRaw({
      documentId: docId,
      userId: USER_A,
      body: Buffer.from('bytes-fail'),
      contentType: 'text/plain',
    });
    const linked = (await getRawDocumentById(pool, USER_A, docId))!.storageArtifactId!;
    await syncArtifactStatusFromRawDocument(pool, {
      rawDocumentId: docId,
      newRawStatus: 'blob_archival_failed',
      lastError: { code: 'archival_timeout', message: 'provider timeout' },
    });
    const artifact = await getStorageArtifactById(pool, USER_A, linked);
    expect(artifact!.status).toBe('failed');
    expect(artifact!.lastError).toEqual({ code: 'archival_timeout', message: 'provider timeout' });
  });
});

describe('Step 7 — delete cascade flips the artifact to deleted', () => {
  it('soft-deletes a managed artifact when the document is deleted (cleanup path)', async () => {
    const docId = await registerWithExternalUri('ext-delete-cascade-1');
    await service.uploadRaw({
      documentId: docId,
      userId: USER_A,
      body: Buffer.from('cascade-bytes'),
      contentType: 'text/plain',
    });
    const before = await getRawDocumentById(pool, USER_A, docId);
    const artifactId = before!.storageArtifactId!;
    await service.delete(USER_A, docId);
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, artifactId);
    expect(artifact!.status).toBe('deleted');
    expect(artifact!.deletedAt).not.toBeNull();
  });

  it('pointer-only document delete soft-deletes the linked pointer artifact in the cascade tx (no managed cleanup path)', async () => {
    const docId = await registerWithExternalUri('ext-pointer-delete-1');
    const before = await getRawDocumentById(pool, USER_A, docId);
    const artifactId = before!.storageArtifactId!;
    // Pointer-only doc: service.delete returns success with no
    // blob cleanup needed. The artifact MUST still flip to deleted
    // via the same cascade transaction.
    await service.delete(USER_A, docId);
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, artifactId);
    expect(artifact!.status).toBe('deleted');
    expect(artifact!.deletedAt).not.toBeNull();
  });
});

describe('Step 7 — source reset cleans up linked pointer artifacts', () => {
  it('deleteBySource soft-deletes linked pointer artifacts in the same tx (no orphan active links)', async () => {
    const { deleteBySource } = await import('../../db/repository-document-delete.js');
    const docId = await registerWithExternalUri('ext-source-reset-1');
    const before = await getRawDocumentById(pool, USER_A, docId);
    const artifactId = before!.storageArtifactId!;
    await deleteBySource(pool, USER_A, 'drive');
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, artifactId);
    expect(artifact!.status).toBe('deleted');
    expect(artifact!.deletedAt).not.toBeNull();
  });
});

describe('Step 7 — id-keyed cleanup-sync survives duplicate URIs across documents', () => {
  it('managed-blob cleanup syncs only the targeted artifact when two managed docs share storage_uri', async () => {
    // Two managed-blob documents pointing at the same storage_uri.
    // (Legal — the FK only constrains artifact identity, not URI
    // uniqueness.) Each carries its own managed artifact. After
    // service.delete on docA, the cleanup loop must use the
    // ManagedBlobRef's rawDocumentId — not the URI — to sync ONLY
    // docA's artifact; docB stays active even though they share
    // the URI.
    const docA = await registerWithExternalUri('ext-dup-managed-a');
    await service.uploadRaw({
      documentId: docA, userId: USER_A,
      body: Buffer.from('managed-A'), contentType: 'text/plain',
    });
    const docB = await registerWithExternalUri('ext-dup-managed-b');
    await service.uploadRaw({
      documentId: docB, userId: USER_A,
      body: Buffer.from('managed-B'), contentType: 'text/plain',
    });
    const aArtifactId = (await getRawDocumentById(pool, USER_A, docA))!.storageArtifactId!;
    const bArtifactId = (await getRawDocumentById(pool, USER_A, docB))!.storageArtifactId!;
    // Force the docs to share `storage_uri` (using the docA URI so
    // the local_fs adapter still accepts it during cleanup) so any
    // URI-keyed sync path would clobber both. The id-keyed path
    // must touch only A.
    const aUri = (await getRawDocumentById(pool, USER_A, docA))!.storageUri!;
    await pool.query(
      `UPDATE raw_documents SET storage_uri = $1 WHERE id IN ($2, $3)`,
      [aUri, docA, docB],
    );
    await service.delete(USER_A, docA);
    const a = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, aArtifactId);
    const b = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, bArtifactId);
    expect(a!.status).toBe('deleted');
    expect(b!.status).toBe('stored');
    expect(b!.deletedAt).toBeNull();
  });
});

describe('Step 7 — cleanup sync refuses cross-user mismatch', () => {
  it('markCleanupSuccessAndSyncArtifact skips artifact sync when userId does not own rawDocumentId', async () => {
    const { markCleanupSuccessAndSyncArtifact } = await import('../../db/raw-doc-artifact-sync.js');
    const docId = await registerWithExternalUri('ext-cross-user-1');
    const artifactId = (await getRawDocumentById(pool, USER_A, docId))!.storageArtifactId!;
    // Caller supplies USER_B (mismatched) — the raw_documents
    // UPDATE matches 0 rows, so the artifact must NOT flip.
    await markCleanupSuccessAndSyncArtifact(pool, {
      userId: USER_B,
      rawDocumentId: docId,
      storageUri: 'irrelevant',
      semantics: 'deleted',
    });
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER_A, artifactId);
    expect(artifact!.status).toBe('stored');
    expect(artifact!.deletedAt).toBeNull();
  });
});

describe('Step 7 — full-wipe path handles storage_artifacts', () => {
  async function countArtifacts(userId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM storage_artifacts WHERE user_id = $1`,
      [userId],
    );
    return Number(result.rows[0].count);
  }

  it('user-scoped deleteAll removes the user storage_artifacts after raw_documents', async () => {
    const { deleteAll } = await import('../../db/repository-wipe.js');
    const docId = await registerWithExternalUri('ext-wipe-1');
    await service.uploadRaw({
      documentId: docId, userId: USER_A,
      body: Buffer.from('wipe-bytes'), contentType: 'text/plain',
    });
    expect(await countArtifacts(USER_A)).toBeGreaterThan(0);
    await deleteAll(pool, USER_A, {
      rawContentStore: (service as unknown as { rawContentStore: unknown }).rawContentStore as never,
      storeRegistry: undefined,
    });
    expect(await countArtifacts(USER_A)).toBe(0);
  });

  it('global deleteAll removes storage_artifacts across all users', async () => {
    const { deleteAll } = await import('../../db/repository-wipe.js');
    await registerWithExternalUri('ext-wipe-global-a');
    // Add a USER_B artifact too.
    const sourceB = await upsertRawSource(pool, {
      userId: USER_B, sourceSite: 'drive', provider: 'google-drive',
    });
    await registerRawDocument(pool, {
      userId: USER_B,
      rawSourceId: sourceB.id,
      externalId: 'ext-wipe-global-b',
      externalUri: 'https://example.com/b',
      storageMode: 'pointer_only',
    });
    expect(await countArtifacts(USER_A)).toBeGreaterThan(0);
    expect(await countArtifacts(USER_B)).toBeGreaterThan(0);
    await deleteAll(pool);
    expect(await countArtifacts(USER_A)).toBe(0);
    expect(await countArtifacts(USER_B)).toBe(0);
  });
});
