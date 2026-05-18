/**
 * Storage route error-envelope tests — split out from
 * `storage-routes.test.ts` so both files stay under the workspace
 * 400-LOC test cap.
 *
 * Covers:
 *   - `BackendNotRegisteredError` on read → 503
 *     `storage_backend_unavailable`.
 *   - `ArtifactNotReadyError` on pending row → 409.
 *   - `ArtifactUnavailableError` on failed (uri=null) row → 410.
 *   - `UnregisteredProviderError` on managed POST → 503.
 *   - `PutPostPersistError` on post-put failure → 503; envelope
 *     never carries the orphan URI.
 *   - Legacy `?user_id=` / body `user_id` rejection → 400.
 *
 * Each test boots its own router (most tests need bespoke service
 * wiring), so the per-suite lifecycle is just schema setup +
 * teardown. Shared `bootStorageRouter` lives in
 * `storage-routes-fixtures.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { StorageService } from '../../services/storage-service.js';
import {
  authHeader,
  authHeaderWithUser,
} from '../../__tests__/helpers/auth-headers.js';
import {
  ROUTE_USER_A,
  bootStorageRouter,
  closeHandle,
  createLocalFsStorageService,
  type SuiteHandle,
} from './storage-routes-fixtures.js';
import { createStorageArtifact } from '../../db/storage-artifact-repository.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER_A = ROUTE_USER_A;
let storageRoot: string;
let localFsHandle: SuiteHandle;

beforeAll(async () => {
  await setupTestSchema(pool);
  const setup = await createLocalFsStorageService({
    pool,
    tmpPrefix: 'storage-routes-env-',
    pointerSchemes: ['https', 's3', 'gs', 'ipfs'],
  });
  storageRoot = setup.storageRoot;
  localFsHandle = await bootStorageRouter(setup.service, 'local_fs');
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await closeHandle(localFsHandle);
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

describe('storage routes — BackendNotRegisteredError surfaces as 503 storage_backend_unavailable', () => {
  it('returns 503 with provider_id when reading a managed artifact whose provider has no registered backend', async () => {
    const row = await createStorageArtifact(pool, {
      userId: USER_A, provider: 's3', mode: 'managed',
      uri: 's3://bucket/k', status: 'stored', sizeBytes: 0,
      contentType: 'text/plain', contentEncoding: 'identity',
      discloseContentHash: false, identifiers: {}, metadata: {},
    });
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${row.id}/content`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error_code: string; provider_id: string };
    expect(body.error_code).toBe('storage_backend_unavailable');
    expect(body.provider_id).toBe('s3');
  });
});

describe('storage routes — lifecycle error envelopes', () => {
  async function insertManagedPending(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding,
         identifiers, lifecycle, metadata, put_attempt_id
       ) VALUES ($1, 'local_fs', 'managed', NULL, 'pending', 'identity',
         '{}', '{}', '{}', $2)
       RETURNING id`,
      [USER_A, '11111111-1111-4111-8111-111111111111'],
    );
    return result.rows[0].id;
  }

  async function insertManagedFailedNoUri(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding,
         identifiers, lifecycle, metadata
       ) VALUES ($1, 'local_fs', 'managed', NULL, 'failed', 'identity',
         '{}', '{}', '{}')
       RETURNING id`,
      [USER_A],
    );
    return result.rows[0].id;
  }

  it('GET /content on a pending managed row returns 409 artifact_not_ready', async () => {
    const id = await insertManagedPending();
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}/content`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string; artifact_id: string };
    expect(body.error_code).toBe('artifact_not_ready');
    expect(body.artifact_id).toBe(id);
  });

  it('GET /content on a failed (uri=null) row returns 410 artifact_unavailable', async () => {
    const id = await insertManagedFailedNoUri();
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}/content`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error_code: string; artifact_id: string };
    expect(body.error_code).toBe('artifact_unavailable');
    expect(body.artifact_id).toBe(id);
  });

  it('managed POST returns 503 storage_backend_unavailable on UnregisteredProviderError', async () => {
    const orphanActive: StorageBackend = {
      provider: 'never-registered',
      put: async () => { throw new Error('should never be called'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => ({ deleted: true, semantics: 'deleted' }),
    };
    const registry = {
      active: orphanActive, get: () => undefined, has: () => false, entries: [],
    };
    const svc = new StorageService({
      pool, backendRegistry: registry, pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const handle = await bootStorageRouter(svc, 'never-registered');
    try {
      const payload = Buffer.from('orphan');
      const res = await fetch(
        `${handle.baseUrl}/v1/storage/artifacts?mode=managed`,
        {
          method: 'POST',
          headers: {
            ...authHeaderWithUser(USER_A),
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(payload.length),
          },
          body: new Uint8Array(payload),
        },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error_code: string; provider_id: string };
      expect(body.error_code).toBe('storage_backend_unavailable');
      expect(body.provider_id).toBe('never-registered');
    } finally {
      await closeHandle(handle);
    }
  });

  it('managed POST returns 503 put_post_persist_failed; envelope has no uri', async () => {
    const failingDelete: StorageBackend = {
      provider: 'local_fs',
      put: async () => ({
        uri: 'local-fs://route-orphan.bin', sizeBytes: 3,
        plaintextHash: 'h', storedHash: 'h', providerMetadata: {},
      }),
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
      delete: async () => { throw new Error('cleanup outage'); },
    };
    const { wrapPoolFailingRecord } = await import('../../__tests__/helpers/pool-wrappers.js');
    const wrappedPool = wrapPoolFailingRecord(pool, 2);
    const svc = new StorageService({
      pool: wrappedPool,
      backendRegistry: {
        active: failingDelete,
        get: (p) => p === 'local_fs' ? failingDelete : undefined,
        has: (p) => p === 'local_fs',
        entries: [['local_fs', failingDelete]],
      },
      pointerSchemes: ['https'],
      storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
    });
    const handle = await bootStorageRouter(svc, 'local_fs');
    try {
      const payload = Buffer.from('post-persist-fail');
      const res = await fetch(
        `${handle.baseUrl}/v1/storage/artifacts?mode=managed`,
        {
          method: 'POST',
          headers: {
            ...authHeaderWithUser(USER_A),
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(payload.length),
          },
          body: new Uint8Array(payload),
        },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error_code).toBe('put_post_persist_failed');
      expect(body.artifact_id).toEqual(expect.any(String));
      expect(body.provider_id).toBe('local_fs');
      expect(body).not.toHaveProperty('uri');
    } finally {
      await closeHandle(handle);
    }
  });
});

describe('storage routes — legacy user_id rejection (X-AtomicMemory-User-Id contract)', () => {
  it('rejects ?user_id= query parameter with 400 legacy_user_id_unsupported', async () => {
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts?user_id=${USER_A}`,
      {
        method: 'POST',
        headers: { ...authHeaderWithUser(USER_A), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'pointer', uri: 'https://example.com/a', content_type: 'text/plain',
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('legacy_user_id_unsupported');
  });

  it('rejects body user_id with 400 legacy_user_id_unsupported', async () => {
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts`,
      {
        method: 'POST',
        headers: { ...authHeaderWithUser(USER_A), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'pointer', uri: 'https://example.com/a',
          content_type: 'text/plain', user_id: USER_A,
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('legacy_user_id_unsupported');
  });

  it('rejects missing X-AtomicMemory-User-Id header with 400 invalid_metadata_header', async () => {
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts`,
      {
        method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'pointer', uri: 'https://example.com/a', content_type: 'text/plain',
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('invalid_metadata_header');
  });
});
