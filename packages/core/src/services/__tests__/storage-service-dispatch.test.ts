/**
 * Per-row backend dispatch + pointer-mode short-circuit tests.
 *
 * Covers the Step-7 follow-up Commit B contract: managed artifacts
 * dispatch to the backend named on the row (not the active backend);
 * pointer artifacts never consult the backend registry for
 * get/delete/verify; missing managed backends raise the typed
 * `BackendNotRegisteredError` that the route maps to 503
 * `storage_backend_unavailable`.
 *
 * The service is constructed with a real local_fs backend for the
 * common happy path, plus crafted registries (legacy-only, empty)
 * for the dispatch-failure and pointer-short-circuit edges.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { createStorageArtifact } from '../../db/storage-artifact-repository.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { RawContentStoreBackendAdapter } from '../../storage/raw-content-store-backend-adapter.js';
import {
  buildBackendRegistry,
  singleBackendRegistry,
} from '../../storage/storage-backend-registry.js';
import { StorageService } from '../storage-service.js';
import {
  BackendNotRegisteredError,
  PointerContentNotManagedError,
} from '../storage-service-errors.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'storage-dispatch-user';

let storageRoot: string;
let localFsBackend: StorageBackend;

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'storage-svc-dispatch-'));
  localFsBackend = new RawContentStoreBackendAdapter(
    new LocalFsRawContentStore({ root: storageRoot }),
  );
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

/**
 * Build a fake backend whose `get`/`delete`/`head` recorders prove
 * the service picked the right adapter. Returns the recorders the
 * test can assert on.
 */
function makeRecordingBackend(provider: string) {
  const calls: { fn: string; uri: string }[] = [];
  const backend: StorageBackend = {
    provider,
    put: async () => ({
      uri: `${provider}://stub`, sizeBytes: 0, plaintextHash: 'h', storedHash: 'h',
      providerMetadata: {},
    }),
    get: async (uri) => {
      calls.push({ fn: 'get', uri });
      return { body: Buffer.from(`bytes-from-${provider}`), contentType: null, sizeBytes: 0 };
    },
    head: async (uri) => {
      calls.push({ fn: 'head', uri });
      return { exists: true, sizeBytes: 0, contentType: null };
    },
    delete: async (uri) => {
      calls.push({ fn: 'delete', uri });
      return { deleted: true, semantics: 'deleted' };
    },
  };
  return { backend, calls };
}

/**
 * Direct-insert a managed `storage_artifacts` row carrying the
 * caller-supplied provider/uri. Bypasses `putManaged` so the test
 * can simulate a row written under one backend and read under
 * another (deployment migration).
 */
async function insertManagedArtifact(provider: string, uri: string): Promise<string> {
  const row = await createStorageArtifact(pool, {
    userId: USER,
    provider,
    mode: 'managed',
    uri,
    status: 'stored',
    sizeBytes: 0,
    contentType: 'text/plain',
    contentEncoding: 'identity',
    discloseContentHash: false,
    identifiers: {},
    metadata: {},
  });
  return row.id;
}

describe('StorageService — per-row backend dispatch (managed mode)', () => {
  it('routes a managed read to the legacy backend matching the row provider, not the active one', async () => {
    const { backend: legacy, calls: legacyCalls } = makeRecordingBackend('s3');
    const { backend: active, calls: activeCalls } = makeRecordingBackend('local_fs');
    const svc = new StorageService({
      pool,
      backendRegistry: buildBackendRegistry(active, [legacy]),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://bucket/key');
    const fetched = await svc.getArtifactContent(USER, id);
    expect(legacyCalls).toEqual([{ fn: 'get', uri: 's3://bucket/key' }]);
    expect(activeCalls).toEqual([]);
    expect(fetched.body.toString()).toBe('bytes-from-s3');
  });

  it('raises BackendNotRegisteredError on getArtifactContent when the row provider has no adapter', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://orphaned/object');
    await expect(svc.getArtifactContent(USER, id)).rejects.toBeInstanceOf(
      BackendNotRegisteredError,
    );
  });

  it('raises BackendNotRegisteredError on verifyArtifact when the row provider has no adapter', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://orphaned/object');
    await expect(svc.verifyArtifact(USER, id)).rejects.toBeInstanceOf(
      BackendNotRegisteredError,
    );
  });

  it('raises BackendNotRegisteredError on deleteArtifact for a managed row whose provider has no adapter', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://orphaned/object');
    await expect(
      svc.deleteArtifact({ userId: USER, id, policy: 'artifact_only' }),
    ).rejects.toBeInstanceOf(BackendNotRegisteredError);
  });

  it('missing-backend DELETE leaves status/delete_attempt_id/last_error untouched', async () => {
    // The backend must be resolved BEFORE any DB mutation. A
    // missing-backend DELETE that ever set status='deleting' or
    // cleared last_error would silently corrupt the row even though
    // the API surfaced a 503.
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://orphaned/object');
    // Seed last_error so we can prove it stays untouched.
    await pool.query(
      `UPDATE storage_artifacts
          SET last_error = $1::jsonb
        WHERE id = $2`,
      [JSON.stringify({ layer: 'raw_storage', code: 'prior_error', message: 'kept' }), id],
    );
    await expect(
      svc.deleteArtifact({ userId: USER, id, policy: 'artifact_only' }),
    ).rejects.toBeInstanceOf(BackendNotRegisteredError);
    const after = await pool.query<{
      status: string;
      delete_attempt_id: string | null;
      last_error: Record<string, unknown> | null;
    }>(
      `SELECT status, delete_attempt_id, last_error FROM storage_artifacts WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe('stored');
    expect(after.rows[0].delete_attempt_id).toBeNull();
    expect(after.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'prior_error',
      message: 'kept',
    });
  });

  it('missing-backend DELETE with policy=with_documents does NOT soft-delete linked raw_documents', async () => {
    // Cascade must run only after the backend resolves. A missing-
    // backend DELETE that ever soft-deleted documents would leave
    // the user with deleted docs and an untouched (still-active)
    // artifact — the worst possible state.
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertManagedArtifact('s3', 's3://orphaned/object');
    const { upsertRawSource, registerRawDocument } = await import(
      '../../db/raw-document-repository.js'
    );
    const source = await upsertRawSource(pool, {
      userId: USER, sourceSite: 'drive', provider: 'google-drive',
    });
    const reg = await registerRawDocument(pool, {
      userId: USER,
      rawSourceId: source.id,
      externalId: 'ext-missing-backend',
      storageMode: 'pointer_only',
      externalUri: 'https://example.com/missing-backend',
    });
    await pool.query(
      `UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`,
      [id, reg.document.id],
    );
    await expect(
      svc.deleteArtifact({ userId: USER, id, policy: 'with_documents' }),
    ).rejects.toBeInstanceOf(BackendNotRegisteredError);
    const docRow = await pool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM raw_documents WHERE id = $1`,
      [reg.document.id],
    );
    expect(docRow.rows[0].deleted_at).toBeNull();
  });
});

describe('StorageService — pointer-mode short-circuit (no backend required)', () => {
  it('getArtifactContent on a pointer row returns 409-equivalent without consulting the registry', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(null),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putPointer({
      userId: USER, uri: 'https://example.com/a', contentType: 'text/plain',
    });
    await expect(svc.getArtifactContent(USER, row.id)).rejects.toBeInstanceOf(
      PointerContentNotManagedError,
    );
  });

  it('verifyArtifact on a pointer row returns kind=unsupported without consulting the registry', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(null),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putPointer({
      userId: USER, uri: 'https://example.com/b', contentType: 'text/plain',
    });
    const result = await svc.verifyArtifact(USER, row.id);
    expect(result.kind).toBe('unsupported');
  });

  it('deleteArtifact on a pointer row finalizes successfully even when active=null (no backend.delete call)', async () => {
    const svc = new StorageService({
      pool,
      backendRegistry: singleBackendRegistry(null),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putPointer({
      userId: USER, uri: 'https://example.com/c', contentType: 'text/plain',
    });
    const result = await svc.deleteArtifact({
      userId: USER, id: row.id, policy: 'artifact_only',
    });
    expect(result.artifact.status).toBe('deleted');
  });
});
