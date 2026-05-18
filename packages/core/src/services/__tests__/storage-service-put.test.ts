/**
 * Pending-row-first put lifecycle tests — success + failure-on-put + validation.
 *
 * Recovery-branch tests (post-put DB failure, commit-after-throw,
 * lifecycle gates for pending/failed rows, durable orphan marker)
 * live in the sibling file `storage-service-put-recovery.test.ts`
 * so both files stay under the workspace 400-LOC test cap. Shared
 * fixtures live in `./storage-put-fixtures.ts`.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  buildBackendRegistry,
  singleBackendRegistry,
} from '../../storage/storage-backend-registry.js';
import { StorageService } from '../storage-service.js';
import { UnregisteredProviderError } from '../storage-service-errors.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import { USER, usePutFixtures } from './storage-put-fixtures.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const getFixtures = usePutFixtures();

describe('StorageService — pending-row-first put: happy path', () => {
  it('claim → backend.put → record flips row to stored and clears put_attempt_id', async () => {
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putManaged({
      userId: USER, body: Buffer.from('hello'),
      contentType: 'text/plain', discloseContentHash: true,
    });
    expect(row.status).toBe('stored');
    expect(row.uri).not.toBeNull();
    expect(row.putAttemptId).toBeNull();
    expect(row.sizeBytes).toBe(5);
  });

  it('persists a PII-safe storage URI: `s/<hmac-hex32>/<artifact-id>.bin` and never the raw userId', async () => {
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(localFsBackend), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putManaged({
      userId: USER, body: Buffer.from('private-bytes'),
      contentType: 'text/plain', discloseContentHash: false,
    });
    // The local_fs adapter prefixes its scheme; the artifact-side
    // key is `s/<hmac-hex32>/<artifact-id>.bin`. Asserting against
    // the persisted `row.uri` (not just the key passed to put)
    // proves the PII-safe shape made it all the way to the DB.
    expect(row.uri).toMatch(
      new RegExp(`^local-fs://s/[0-9a-f]{32}/${row.id}\\.bin$`),
    );
    expect(row.uri).not.toContain(USER);
  });
});

describe('StorageService — pending-row-first put: backend.put failure', () => {
  it('marks the row failed with a sanitized envelope and clears put_attempt_id', async () => {
    const failingPut: StorageBackend = {
      provider: 'local_fs',
      put: async () => { throw new Error('simulated put outage'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => ({ deleted: false, semantics: 'deleted' }),
    };
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(failingPut), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    await expect(
      svc.putManaged({
        userId: USER, body: Buffer.from('x'),
        contentType: 'text/plain', discloseContentHash: false,
      }),
    ).rejects.toThrow(/simulated put outage/);
    const result = await pool.query<{
      status: string; uri: string | null;
      put_attempt_id: string | null; last_error: Record<string, unknown> | null;
    }>(
      `SELECT status, uri, put_attempt_id, last_error
         FROM storage_artifacts
         WHERE user_id = $1`,
      [USER],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('failed');
    expect(result.rows[0].uri).toBeNull();
    expect(result.rows[0].put_attempt_id).toBeNull();
    expect(result.rows[0].last_error).toMatchObject({
      layer: 'raw_storage',
      code: 'backend_put_failed',
      message: 'simulated put outage',
      storage_provider: 'local_fs',
    });
  });
});

describe('StorageService — pending-row-first put: provider validation', () => {
  it('rejects with UnregisteredProviderError when active backend is missing from the registry', async () => {
    const orphanActive: StorageBackend = {
      provider: 'never-registered',
      put: async () => { throw new Error('should never be called'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => ({ deleted: true, semantics: 'deleted' }),
    };
    const registry = {
      active: orphanActive,
      get: () => undefined,
      has: () => false,
      entries: [],
    };
    const svc = new StorageService({
      pool, backendRegistry: registry, pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    await expect(
      svc.putManaged({
        userId: USER, body: Buffer.from('x'),
        contentType: 'text/plain', discloseContentHash: false,
      }),
    ).rejects.toBeInstanceOf(UnregisteredProviderError);
  });

  it('happy registry built via buildBackendRegistry passes the validation gate', async () => {
    const { localFsBackend } = getFixtures();
    const svc = new StorageService({
      pool,
      backendRegistry: buildBackendRegistry(localFsBackend),
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const row = await svc.putManaged({
      userId: USER, body: Buffer.from('ok'),
      contentType: 'text/plain', discloseContentHash: false,
    });
    expect(row.status).toBe('stored');
  });
});

describe('StorageService — pending/failed rows surface uri:null', () => {
  it('failed row from backend.put failure has uri=null on the wire', async () => {
    const failingPut: StorageBackend = {
      provider: 'local_fs',
      put: async () => { throw new Error('put outage'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => ({ deleted: true, semantics: 'deleted' }),
    };
    const svc = new StorageService({
      pool, backendRegistry: singleBackendRegistry(failingPut), pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    await expect(svc.putManaged({
      userId: USER, body: Buffer.from('x'),
      contentType: 'text/plain', discloseContentHash: false,
    })).rejects.toThrow();
    const rows = await pool.query<{ id: string }>(
      `SELECT id FROM storage_artifacts WHERE user_id = $1`, [USER],
    );
    const row = await svc.getArtifactMetadata(USER, rows.rows[0].id);
    expect(row.status).toBe('failed');
    expect(row.uri).toBeNull();
  });
});
