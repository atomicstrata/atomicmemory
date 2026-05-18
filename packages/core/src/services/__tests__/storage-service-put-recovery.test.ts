/**
 * Pending-row-first put recovery + lifecycle-gate tests.
 *
 * Sibling to `storage-service-put.test.ts`; the split keeps both
 * files under the workspace 400-LOC test cap. Shared fixtures live
 * in `./storage-put-fixtures.ts`.
 *
 * Coverage:
 *   - post-put DB-update failure → backend.delete + durable failed
 *     marker carries the cleanup envelope;
 *   - post-put DB-update + backend cleanup both fail → durable
 *     `put_post_persist_unrecoverable` envelope carries the orphan
 *     URI server-side, throws `PutPostPersistError`;
 *   - clean CAS miss (UPDATE returns rowCount=0 without throwing
 *     twice) → recovery synthesizes a typed Error, never propagates
 *     `undefined`;
 *   - commit-after-throw reconciliation: UPDATE commits then client
 *     throws → reconcile returns the stored row, no cleanup;
 *   - lifecycle gates for pending and failed (uri=null) rows on
 *     `getArtifactContent`, `verifyArtifact`, `deleteArtifact`.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { RawContentStoreBackendAdapter } from '../../storage/raw-content-store-backend-adapter.js';
import { singleBackendRegistry } from '../../storage/storage-backend-registry.js';
import { StorageService } from '../storage-service.js';
import { PutPostPersistError } from '../storage-service-errors.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import { USER, usePutFixtures } from './storage-put-fixtures.js';
import {
  wrapPoolCasMiss,
  wrapPoolCommitThenThrow,
  wrapPoolFailingRecord,
} from '../../__tests__/helpers/pool-wrappers.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const getFixtures = usePutFixtures();

describe('StorageService — pending-row-first put: post-put DB failure', () => {
  it('cleanup succeeds → row at failed with durable cleaned-up envelope, original error re-thrown', async () => {
    // Wrap the real backend so `put` actually writes bytes and
    // `delete` records the URI it was asked to remove. The
    // backend's `delete` returns the standard `{deleted, semantics}`
    // envelope so the recovery path believes cleanup succeeded.
    const deleteCalls: string[] = [];
    const { storageRoot } = getFixtures();
    // Build a tracking wrapper around the suite-owned local_fs
    // store so the test can record `delete` calls without losing
    // the put/get/head pass-through. Rooting at the fixture's
    // `storageRoot` keeps cleanup deterministic.
    const realBackend = new RawContentStoreBackendAdapter(
      new LocalFsRawContentStore({ root: storageRoot }),
    );
    const trackingBackend: StorageBackend = {
      provider: 'local_fs',
      put: (input) => realBackend.put(input),
      get: (uri) => realBackend.get(uri),
      head: (uri) => realBackend.head(uri),
      delete: async (uri: string) => {
        deleteCalls.push(uri);
        return realBackend.delete(uri);
      },
    };
    const wrapped = wrapPoolFailingRecord(pool, 2);
    const svc = new StorageService({
      pool: wrapped,
      backendRegistry: singleBackendRegistry(trackingBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    await expect(
      svc.putManaged({
        userId: USER, body: Buffer.from('recovery'),
        contentType: 'text/plain', discloseContentHash: false,
      }),
    ).rejects.toThrow(/forced post-put UPDATE failure/);
    expect(deleteCalls).toHaveLength(1);
    const result = await pool.query<{
      status: string; uri: string | null;
      put_attempt_id: string | null; last_error: Record<string, unknown> | null;
    }>(
      `SELECT status, uri, put_attempt_id, last_error
         FROM storage_artifacts WHERE user_id = $1`,
      [USER],
    );
    expect(result.rows[0].status).toBe('failed');
    expect(result.rows[0].uri).toBeNull();
    expect(result.rows[0].put_attempt_id).toBeNull();
    expect(result.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'put_post_persist_failed_cleaned_up',
    });
  });

  it('cleanup also fails → throws PutPostPersistError; row carries durable orphan-uri envelope', async () => {
    const failingDelete: StorageBackend = {
      provider: 'local_fs',
      put: async () => ({
        uri: 'local-fs://forced-orphan.bin',
        sizeBytes: 4, plaintextHash: 'h', storedHash: 'h',
        providerMetadata: {},
      }),
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => { throw new Error('simulated cleanup outage'); },
    };
    const wrapped = wrapPoolFailingRecord(pool, 2);
    const svc = new StorageService({
      pool: wrapped,
      backendRegistry: singleBackendRegistry(failingDelete),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    await expect(
      svc.putManaged({
        userId: USER, body: Buffer.from('unrecoverable'),
        contentType: 'text/plain', discloseContentHash: false,
      }),
    ).rejects.toBeInstanceOf(PutPostPersistError);
    const result = await pool.query<{
      status: string; put_attempt_id: string | null;
      last_error: Record<string, unknown> | null;
    }>(
      `SELECT status, put_attempt_id, last_error
         FROM storage_artifacts WHERE user_id = $1`,
      [USER],
    );
    // The durable marker flipped the row to 'failed' (NOT pending),
    // cleared the claim id, and stored the orphan URI on the
    // internal envelope so the reconciler can find it.
    expect(result.rows[0].status).toBe('failed');
    expect(result.rows[0].put_attempt_id).toBeNull();
    expect(result.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'put_post_persist_unrecoverable',
      orphan_uri: 'local-fs://forced-orphan.bin',
      storage_provider: 'local_fs',
    });
  });

  it('clean CAS miss (UPDATE returns 0 rows twice) recovers with a typed Error, never undefined', async () => {
    // The previous recovery path could surface `undefined` as the
    // re-thrown error when neither attempt threw but both CAS calls
    // missed and reconciliation found no row. The synthesized error
    // must carry a real message + the artifact id (no URI).
    const trackedDelete: { uri: string | null } = { uri: null };
    const trackingBackend: StorageBackend = {
      provider: 'local_fs',
      put: async () => ({
        uri: 'local-fs://forced-cas-miss.bin',
        sizeBytes: 4, plaintextHash: 'h', storedHash: 'h',
        providerMetadata: {},
      }),
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async (uri: string) => {
        trackedDelete.uri = uri;
        return { deleted: true, semantics: 'deleted' };
      },
    };
    const wrapped = wrapPoolCasMiss(pool, 2);
    const svc = new StorageService({
      pool: wrapped,
      backendRegistry: singleBackendRegistry(trackingBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    let caught: unknown;
    await svc.putManaged({
      userId: USER, body: Buffer.from('cas-miss'),
      contentType: 'text/plain', discloseContentHash: false,
    }).catch((err) => { caught = err; });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CAS missed/);
    expect((caught as Error).message).not.toMatch(/undefined/);
    expect(trackedDelete.uri).toBe('local-fs://forced-cas-miss.bin');
    const result = await pool.query<{ status: string; last_error: Record<string, unknown> | null }>(
      `SELECT status, last_error FROM storage_artifacts WHERE user_id = $1`,
      [USER],
    );
    expect(result.rows[0].status).toBe('failed');
    expect(result.rows[0].last_error).toMatchObject({
      code: 'put_post_persist_failed_cleaned_up',
    });
  });
});

describe('StorageService — commit-after-throw reconciliation', () => {
  it('UPDATE commits but client throws → reconcile returns the stored row, bytes are NOT deleted', async () => {
    let deleteCalls = 0;
    const { storageRoot } = getFixtures();
    const realBackend = new RawContentStoreBackendAdapter(
      new LocalFsRawContentStore({ root: storageRoot }),
    );
    const trackingBackend: StorageBackend = {
      provider: 'local_fs',
      put: (input) => realBackend.put(input),
      get: (uri) => realBackend.get(uri),
      head: (uri) => realBackend.head(uri),
      delete: async (uri) => {
        deleteCalls++;
        return realBackend.delete(uri);
      },
    };
    const wrapped = wrapPoolCommitThenThrow(pool, 1);
    const svc = new StorageService({
      pool: wrapped,
      backendRegistry: singleBackendRegistry(trackingBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putManaged({
      userId: USER, body: Buffer.from('committed-after-throw'),
      contentType: 'text/plain', discloseContentHash: false,
    });
    expect(row.status).toBe('stored');
    expect(row.uri).not.toBeNull();
    expect(deleteCalls).toBe(0);
  });
});

describe('StorageService — lifecycle gates for pending / failed rows', () => {
  async function insertPending(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding,
         identifiers, lifecycle, metadata, put_attempt_id
       ) VALUES ($1, 'local_fs', 'managed', NULL, 'pending', 'identity',
         '{}', '{}', '{}', $2)
       RETURNING id`,
      [USER, '00000000-0000-0000-0000-000000000001'],
    );
    return result.rows[0].id;
  }

  async function insertFailedNoUri(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding,
         identifiers, lifecycle, metadata
       ) VALUES ($1, 'local_fs', 'managed', NULL, 'failed', 'identity',
         '{}', '{}', '{}')
       RETURNING id`,
      [USER],
    );
    return result.rows[0].id;
  }

  it('getArtifactContent on a pending row throws ArtifactNotReadyError', async () => {
    const { ArtifactNotReadyError } = await import('../storage-service-errors.js');
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertPending();
    await expect(svc.getArtifactContent(USER, id)).rejects.toBeInstanceOf(ArtifactNotReadyError);
  });

  it('getArtifactContent on a failed (uri=null) row throws ArtifactUnavailableError', async () => {
    const { ArtifactUnavailableError } = await import('../storage-service-errors.js');
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertFailedNoUri();
    await expect(svc.getArtifactContent(USER, id)).rejects.toBeInstanceOf(ArtifactUnavailableError);
  });

  it('verifyArtifact on a pending row returns kind=unsupported (not yet ready)', async () => {
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertPending();
    expect((await svc.verifyArtifact(USER, id)).kind).toBe('unsupported');
  });

  it('verifyArtifact on a failed (uri=null) row returns kind=failed', async () => {
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertFailedNoUri();
    expect((await svc.verifyArtifact(USER, id)).kind).toBe('failed');
  });

  it('deleteArtifact on a failed (uri=null) row is DB-only — no backend.delete call', async () => {
    let deleteCalls = 0;
    const { localFsBackend } = getFixtures();
    const trackingBackend: StorageBackend = {
      ...localFsBackend,
      delete: async () => { deleteCalls++; return { deleted: true, semantics: 'deleted' }; },
    };
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(trackingBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const id = await insertFailedNoUri();
    const result = await svc.deleteArtifact({ userId: USER, id, policy: 'artifact_only' });
    expect(result.artifact.status).toBe('deleted');
    expect(deleteCalls).toBe(0);
  });

  it('deleteArtifact on a managed row with an unregistered provider but uri=null is DB-only — no 503', async () => {
    const { localFsBackend } = getFixtures();
    const id = await pool.query<{ id: string }>(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding,
         identifiers, lifecycle, metadata
       ) VALUES ($1, 'never-registered', 'managed', NULL, 'failed', 'identity',
         '{}', '{}', '{}')
       RETURNING id`,
      [USER],
    );
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const result = await svc.deleteArtifact({
      userId: USER, id: id.rows[0].id, policy: 'artifact_only',
    });
    expect(result.artifact.status).toBe('deleted');
  });
});
