/**
 * Cleanup-failure `last_error` envelope tests.
 *
 * The cleanup boundary (`cleanupManagedBlobs`) already surfaces an
 * adapter-specific failure `message`. Step 7 follow-up #4 makes sure
 * that message survives the DB markers: both `raw_documents.last_error`
 * AND the linked `storage_artifacts.last_error` must carry the
 * `{ layer: 'raw_storage', code, message, storage_provider, occurred_at }`
 * envelope so ops / UI can read a durable failure cause from either
 * row.
 *
 * Two paths are exercised:
 *   - `DocumentService.delete` -> `runBlobCleanupOrThrow`
 *     (document-level cleanup failure)
 *   - `deleteAll(userId)` -> `markDeleteAllCleanupFailure`
 *     (full-wipe cleanup failure)
 *
 * Each path constructs a failing managed-blob backend, runs the
 * cleanup, and asserts the envelope shape on both rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { DocumentService } from '../../services/document-service.js';
import { LocalFsRawContentStore } from '../local-fs-store.js';
import { deleteAll } from '../../db/repository-wipe.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import { getStorageArtifactByIdIncludingDeleted } from '../../db/storage-artifact-repository.js';
import {
  buildRawStorageCleanupFailureEnvelope,
  markCleanupFailedAndSyncArtifact,
} from '../../db/raw-doc-artifact-sync.js';
import { MAX_LAST_ERROR_MESSAGE_CHARS } from '../../db/raw-document-status-repository.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'cleanup-last-error-user';
const PAYLOAD = Buffer.from('cleanup-last-error-bytes', 'utf8');
const PROVIDER_MESSAGE = 'simulated provider outage 503';

let storageRoot: string;
let store: LocalFsRawContentStore;
let healthyService: DocumentService;

interface SeedResult {
  documentId: string;
  artifactId: string;
}

async function seedManagedDoc(externalId: string): Promise<SeedResult> {
  const src = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'drive', provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId,
  });
  await healthyService.uploadRaw({
    userId: USER, documentId: reg.document.id, body: PAYLOAD,
  });
  const linked = await pool.query<{ storage_artifact_id: string }>(
    `SELECT storage_artifact_id FROM raw_documents WHERE id = $1`,
    [reg.document.id],
  );
  return { documentId: reg.document.id, artifactId: linked.rows[0].storage_artifact_id };
}

function makeFailingStore(): LocalFsRawContentStore {
  return {
    provider: 'local_fs' as const,
    put: store.put.bind(store),
    get: store.get.bind(store),
    head: store.head.bind(store),
    delete: async () => { throw new Error(PROVIDER_MESSAGE); },
  } as unknown as LocalFsRawContentStore;
}

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-cleanup-last-error-'));
  store = new LocalFsRawContentStore({ root: storageRoot });
  healthyService = new DocumentService(pool, {
    rawContentStore: store,
    config: { rawStoragePrefix: 'cleanup-err', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
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

describe('cleanup failure - DocumentService.delete persists raw_storage envelope', () => {
  it('records last_error on raw_documents AND the linked storage_artifact', async () => {
    const { documentId, artifactId } = await seedManagedDoc('doc-cleanup-1');
    const failingService = new DocumentService(pool, {
      rawContentStore: makeFailingStore(),
      config: { rawStoragePrefix: 'cleanup-err', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(failingService.delete(USER, documentId)).rejects.toThrow(/cleanup failed/);
    const doc = await pool.query<{ last_error: Record<string, unknown> | null }>(
      `SELECT last_error FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    expect(doc.rows[0].last_error).not.toBeNull();
    expect(doc.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'managed_blob_cleanup_failed',
      message: PROVIDER_MESSAGE,
      storage_provider: 'local_fs',
    });
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER, artifactId);
    expect(artifact!.status).toBe('failed');
    expect(artifact!.lastError).toMatchObject({
      layer: 'raw_storage',
      code: 'managed_blob_cleanup_failed',
      message: PROVIDER_MESSAGE,
      storage_provider: 'local_fs',
    });
  });
});

describe('cleanup failure - envelope sanitization + cap', () => {
  it('persists a sanitized, capped message even when the provider error is huge and multi-line', async () => {
    const { documentId, artifactId } = await seedManagedDoc('sanitize-1');
    // Construct the NUL byte at runtime so the TypeScript source
    // stays text-only. A literal NUL in the source would make Git
    // treat this file as binary and break normal diffs/tooling.
    const nul = String.fromCharCode(0);
    const bloated = 'line1\nline2\twith\ttabs\r\nNUL' + nul + 'end '
      + 'X'.repeat(MAX_LAST_ERROR_MESSAGE_CHARS + 500);
    const failingStore = {
      provider: 'local_fs' as const,
      put: store.put.bind(store),
      get: store.get.bind(store),
      head: store.head.bind(store),
      delete: async () => { throw new Error(bloated); },
    } as unknown as LocalFsRawContentStore;
    const failingService = new DocumentService(pool, {
      rawContentStore: failingStore,
      config: { rawStoragePrefix: 'cleanup-err', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
    });
    await expect(failingService.delete(USER, documentId)).rejects.toThrow(/cleanup failed/);
    const doc = await pool.query<{ last_error: { message: string } | null }>(
      `SELECT last_error FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    const docMsg = doc.rows[0].last_error!.message;
    expect(docMsg.length).toBeLessThanOrEqual(MAX_LAST_ERROR_MESSAGE_CHARS);
    // \x00 escape keeps the regex source ASCII-only; asserts no
    // NUL / newline / carriage-return / tab survived sanitization.
    expect(docMsg).not.toMatch(/[\n\r\t\x00]/);
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER, artifactId);
    const artifactMsg = (artifact!.lastError as { message: string }).message;
    expect(artifactMsg.length).toBeLessThanOrEqual(MAX_LAST_ERROR_MESSAGE_CHARS);
    expect(artifactMsg).not.toMatch(/[\n\r\t\x00]/);
    expect(artifactMsg).toBe(docMsg);
  });
});

describe('cleanup failure - retry refreshes last_error on an already-failed row', () => {
  it('replaces a stale last_error on both raw_documents and the linked artifact', async () => {
    const { documentId, artifactId } = await seedManagedDoc('retry-refresh-1');
    // Seed prior failure state: row at raw_storage_failed, both
    // sides carrying an "old" envelope. Mirrors the real-world
    // retry-after-failure flow.
    const oldEnv = buildRawStorageCleanupFailureEnvelope('old provider 500', 'local_fs');
    await markCleanupFailedAndSyncArtifact(pool, {
      userId: USER, rawDocumentId: documentId, lastError: oldEnv,
    });
    const newEnv = buildRawStorageCleanupFailureEnvelope('fresh provider 503', 'local_fs');
    await markCleanupFailedAndSyncArtifact(pool, {
      userId: USER, rawDocumentId: documentId, lastError: newEnv,
    });
    const doc = await pool.query<{ raw_storage_status: string; last_error: { message: string } | null }>(
      `SELECT raw_storage_status, last_error FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    expect(doc.rows[0].raw_storage_status).toBe('raw_storage_failed');
    expect(doc.rows[0].last_error!.message).toBe('fresh provider 503');
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER, artifactId);
    expect((artifact!.lastError as { message: string }).message).toBe('fresh provider 503');
  });
});

describe('cleanup failure - deleteAll persists raw_storage envelope', () => {
  it('user-scoped deleteAll surfaces the provider message on both rows', async () => {
    const { documentId, artifactId } = await seedManagedDoc('wipe-cleanup-1');
    await expect(
      deleteAll(pool, USER, { rawContentStore: makeFailingStore() }),
    ).rejects.toThrow(/cleanup failed/);
    const doc = await pool.query<{ last_error: Record<string, unknown> | null }>(
      `SELECT last_error FROM raw_documents WHERE id = $1`,
      [documentId],
    );
    expect(doc.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'managed_blob_cleanup_failed',
      message: PROVIDER_MESSAGE,
      storage_provider: 'local_fs',
    });
    const artifact = await getStorageArtifactByIdIncludingDeleted(pool, USER, artifactId);
    expect(artifact!.lastError).toMatchObject({
      layer: 'raw_storage',
      code: 'managed_blob_cleanup_failed',
      message: PROVIDER_MESSAGE,
      storage_provider: 'local_fs',
    });
  });
});
