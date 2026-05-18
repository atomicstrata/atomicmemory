/**
 * Service-level integration tests for `StorageService` (the storage-route implementation).
 *
 * Exercises pointer + managed put, owner-scoped read paths, the
 * verify shim, the Filecoin direct-managed-upload carve-out, and
 * the orphan-cleanup path for failed DB persistence. Delete-policy
 * state-machine coverage lives in the sibling file
 * `storage-service-delete.test.ts` so both files stay under the
 * 400-non-comment-LOC test cap. Managed-mode backend uses an
 * in-process `local_fs` adapter rooted at a temp dir so the test
 * does not require S3 / Filecoin credentials.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import {
  StorageService,
  sha256Hex,
} from '../storage-service.js';
import {
  FilecoinDirectStorageNotSupportedError,
  ManagedStorageDisabledError,
  PointerContentNotManagedError,
  StorageArtifactNotFoundError,
  UnsupportedPointerSchemeError,
} from '../storage-service-errors.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import {
  createStorageService,
  createStorageServiceWithPool,
  makeStubStorageBackend,
  useStorageServiceFixture,
} from './storage-service-test-helpers.js';

const USER_A = 'storage-svc-user-a';
const USER_B = 'storage-svc-user-b';

const fixture = useStorageServiceFixture({ tempPrefix: 'storage-svc-' });

function pointerOnlyService(): StorageService {
  return createStorageService(null, ['https']);
}

function filecoinBackendService(): StorageService {
  return createStorageService(makeStubStorageBackend({ provider: 'filecoin' }), ['https', 'ipfs']);
}

describe('StorageService — pointer mode', () => {
  it('stores a pointer artifact with status=stored and never touches a backend', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/file.pdf',
      contentType: 'application/pdf',
      metadata: { source: 'drive' },
    });
    expect(row.mode).toBe('pointer');
    expect(row.status).toBe('stored');
    expect(row.plaintextHash).toBeNull();
    expect(row.storedHash).toBeNull();
    expect(row.metadata).toEqual({ source: 'drive' });
  });

  it('rejects a pointer URI whose scheme is not in the allowlist', async () => {
    await expect(
      fixture.service.putPointer({
        userId: USER_A,
        uri: 'local-fs:///etc/passwd',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(UnsupportedPointerSchemeError);
  });

  it('getArtifactContent on a pointer returns 409-equivalent error (no backend fetch)', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/file.pdf',
      contentType: 'application/pdf',
    });
    await expect(
      fixture.service.getArtifactContent(USER_A, row.id),
    ).rejects.toBeInstanceOf(PointerContentNotManagedError);
  });

  it('verifyArtifact on a pointer returns unsupported (server does not probe URIs)', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/file.pdf',
      contentType: 'application/pdf',
    });
    const result = await fixture.service.verifyArtifact(USER_A, row.id);
    expect(result.kind).toBe('unsupported');
  });
});

describe('StorageService — managed mode (local_fs)', () => {
  it('uploads bytes, stores plaintext_hash and stored_hash, and round-trips via getContent', async () => {
    const body = Buffer.from('hello world');
    const row = await fixture.service.putManaged({
      userId: USER_A,
      body,
      contentType: 'text/plain',
      discloseContentHash: true,
    });
    expect(row.mode).toBe('managed');
    expect(row.sizeBytes).toBe(body.length);
    expect(row.plaintextHash).toBe(sha256Hex(body));
    expect(row.storedHash).toBe(sha256Hex(body));
    expect(row.discloseContentHash).toBe(true);
    const content = await fixture.service.getArtifactContent(USER_A, row.id);
    expect(Buffer.compare(content.body, body)).toBe(0);
  });

  it('default discloseContentHash=false still stores plaintext_hash internally', async () => {
    const body = Buffer.from('private');
    const row = await fixture.service.putManaged({
      userId: USER_A,
      body,
      contentType: 'text/plain',
      discloseContentHash: false,
    });
    expect(row.plaintextHash).toBe(sha256Hex(body));
    expect(row.discloseContentHash).toBe(false);
  });

  it('throws ManagedStorageDisabledError when no backend is configured', async () => {
    await expect(
      pointerOnlyService().putManaged({
        userId: USER_A,
        body: Buffer.from('x'),
        contentType: 'text/plain',
        discloseContentHash: false,
      }),
    ).rejects.toBeInstanceOf(ManagedStorageDisabledError);
  });

  it('Filecoin direct managed upload is 501-equivalent (never touches the backend)', async () => {
    await expect(
      filecoinBackendService().putManaged({
        userId: USER_A,
        body: Buffer.from('x'),
        contentType: 'text/plain',
        discloseContentHash: false,
      }),
    ).rejects.toBeInstanceOf(FilecoinDirectStorageNotSupportedError);
  });

  it('Filecoin direct managed upload throws the typed 501 BEFORE any storage_artifacts row is created', async () => {
    const before = await artifactRowCount();
    let caught: unknown;
    try {
      await filecoinBackendService().putManaged({
        userId: USER_A,
        body: Buffer.from('x'),
        contentType: 'text/plain',
        discloseContentHash: false,
      });
      throw new Error('expected FilecoinDirectStorageNotSupportedError');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FilecoinDirectStorageNotSupportedError);
    const after = await artifactRowCount();
    expect(after).toBe(before);
  });
});

async function artifactRowCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM storage_artifacts',
  );
  return Number.parseInt(result.rows[0].count, 10);
}

describe('StorageService — owner scoping', () => {
  it('getArtifactMetadata throws for a cross-user caller', async () => {
    const row = await fixture.service.putPointer({
      userId: USER_A,
      uri: 'https://example.com/a',
      contentType: 'text/plain',
    });
    await expect(
      fixture.service.getArtifactMetadata(USER_B, row.id),
    ).rejects.toBeInstanceOf(StorageArtifactNotFoundError);
  });
});

describe('StorageService — pending-row-first put: pre-put DB failure', () => {
  it('claim-pending INSERT failure aborts before backend.put is called (no orphan bytes possible)', async () => {
    // Pending-row-first contract: backend.put NEVER runs if the
    // pre-put claim INSERT fails. There is no window where bytes
    // could orphan at the backend.
    let backendPutCalls = 0;
    const fakeBackend: StorageBackend = {
      provider: 'local_fs',
      put: async () => { backendPutCalls++; throw new Error('should not be called'); },
      get: async () => { throw new Error('not used'); },
      head: async () => ({ exists: true, sizeBytes: 1, contentType: null }),
      delete: async () => { throw new Error('not used'); },
    };
    const failingPool = {
      query: async () => { throw new Error('forced claim INSERT failure'); },
    } as unknown as typeof pool;
    const svc = createStorageServiceWithPool(failingPool, fakeBackend, ['https']);
    await expect(
      svc.putManaged({
        userId: USER_A,
        body: Buffer.from('x'),
        contentType: 'text/plain',
        discloseContentHash: false,
      }),
    ).rejects.toThrow(/forced claim INSERT failure/);
    expect(backendPutCalls).toBe(0);
  });
});

describe('StorageService — verify (managed)', () => {
  it('verified for a managed artifact whose bytes the backend reports present', async () => {
    const row = await fixture.service.putManaged({
      userId: USER_A,
      body: Buffer.from('present'),
      contentType: 'text/plain',
      discloseContentHash: false,
    });
    const result = await fixture.service.verifyArtifact(USER_A, row.id);
    expect(result.kind).toBe('verified');
  });

  it('verifies a managed Filecoin artifact via the registered backend.head (per-row dispatch)', async () => {
    // After Commit B + this follow-up, verify no longer hardcodes
    // filecoin as unsupported. The service resolves the backend via
    // the registry and calls its `head` — `filecoinBackendService`
    // is wired with the fake Filecoin backend whose `head` returns
    // `{exists: true}`, so verify must report `kind: 'verified'`.
    await pool.query(
      `INSERT INTO storage_artifacts (
         user_id, provider, mode, uri, status, content_encoding, identifiers, lifecycle, metadata
       ) VALUES ($1, 'filecoin', 'managed', $2, 'stored', 'identity', '{}', '{}', '{}')
       RETURNING id`,
      [USER_A, 'ipfs://bafyplaceholder'],
    );
    const got = await pool.query<{ id: string }>(
      `SELECT id FROM storage_artifacts WHERE user_id = $1 AND provider = 'filecoin' LIMIT 1`,
      [USER_A],
    );
    const result = await filecoinBackendService().verifyArtifact(USER_A, got.rows[0].id);
    expect(result.kind).toBe('verified');
  });
});
