/**
 * Route-level integration tests for `/v1/storage/artifacts*`.
 *
 * Mounts the storage router with a real `StorageService` backed by an
 * in-process `local_fs` store. Exercises:
 *
 *   - pointer + managed put happy paths
 *   - GET metadata + GET content (managed) + GET content (pointer 409)
 *   - HEAD response headers
 *   - DELETE policy / reference-count gate / cascade
 *   - verify pointer-unsupported
 *   - Filecoin direct managed → 501
 *   - invalid metadata (decoded too large) + invalid metadata header (encoded too large)
 *   - explicit rejection of the `force` query parameter
 *   - owner scoping across users
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { RawContentStoreBackendAdapter } from '../../storage/raw-content-store-backend-adapter.js';
import { singleBackendRegistry } from '../../storage/storage-backend-registry.js';
import { StorageService } from '../../services/storage-service.js';
import {
  authHeaderWithUser,
} from '../../__tests__/helpers/auth-headers.js';
import {
  ROUTE_USER_A,
  ROUTE_USER_B,
  ROUTE_MAX_UPLOAD_BYTES,
  bootStorageRouter,
  closeHandle,
  makeFakeFilecoinBackend,
  type SuiteHandle,
} from './storage-routes-fixtures.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER_A = ROUTE_USER_A;
const USER_B = ROUTE_USER_B;
const MAX_UPLOAD_BYTES = ROUTE_MAX_UPLOAD_BYTES;

let storageRoot: string;
let localFsHandle: SuiteHandle;
let filecoinHandle: SuiteHandle;

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'storage-routes-'));
  const localFsService = new StorageService({
    pool,
    backendRegistry: singleBackendRegistry(
      new RawContentStoreBackendAdapter(new LocalFsRawContentStore({ root: storageRoot })),
    ),
    pointerSchemes: ['https', 's3', 'gs', 'ipfs'],
    storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
  });
  const filecoinService = new StorageService({
    pool,
    backendRegistry: singleBackendRegistry(makeFakeFilecoinBackend()),
    pointerSchemes: ['https', 'ipfs'],
    storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
  });
  localFsHandle = await bootStorageRouter(localFsService, 'local_fs');
  filecoinHandle = await bootStorageRouter(filecoinService, 'filecoin');
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await closeHandle(localFsHandle);
  await closeHandle(filecoinHandle);
  await rm(storageRoot, { recursive: true, force: true });
  await pool.end();
});

async function postPointer(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${localFsHandle.baseUrl}/v1/storage/artifacts`, {
    method: 'POST',
    headers: {
      ...authHeaderWithUser(USER_A),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function postManaged(
  payload: Buffer,
  extraHeaders: Record<string, string> = {},
  query: string = '?mode=managed',
  userId: string = USER_A,
): Promise<Response> {
  return fetch(`${localFsHandle.baseUrl}/v1/storage/artifacts${query}`, {
    method: 'POST',
    headers: {
      ...authHeaderWithUser(userId),
      'Content-Type': 'application/octet-stream',
      ...extraHeaders,
    },
    body: new Uint8Array(payload),
  });
}

describe('POST /v1/storage/artifacts — pointer mode', () => {
  it('returns 201 + the public artifact projection (no internal fields)', async () => {
    const res = await postPointer({
      mode: 'pointer',
      uri: 'https://example.com/file.pdf',
      content_type: 'application/pdf',
      metadata: { source: 'drive' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.provider).toBe('local_fs');
    expect(body.mode).toBe('pointer');
    expect(body.metadata).toEqual({ source: 'drive' });
    // Internal columns must never leak on the wire.
    expect(body).not.toHaveProperty('stored_hash');
    expect(body).not.toHaveProperty('plaintext_hash');
    expect(body).not.toHaveProperty('last_error');
    expect(body).not.toHaveProperty('delete_attempt_id');
  });

  it('rejects a pointer URI whose scheme is not allowlisted (400 invalid_pointer_uri_scheme)', async () => {
    const res = await postPointer({
      mode: 'pointer',
      uri: 'local-fs:///etc/passwd',
      content_type: 'application/octet-stream',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_pointer_uri_scheme');
  });

  it('rejects pointer-mode metadata that exceeds the 4 KiB decoded cap', async () => {
    const big = 'x'.repeat(4 * 1024 + 1);
    const res = await postPointer({
      mode: 'pointer',
      uri: 'https://example.com/a',
      content_type: 'text/plain',
      metadata: { payload: big },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_metadata');
  });

  it.each([
    { name: 'negative size_bytes', body: { mode: 'pointer', uri: 'https://e/a', content_type: 't', size_bytes: -1 } },
    { name: 'fractional size_bytes', body: { mode: 'pointer', uri: 'https://e/a', content_type: 't', size_bytes: 1.5 } },
    { name: 'empty content_type', body: { mode: 'pointer', uri: 'https://e/a', content_type: '' } },
    { name: 'empty uri', body: { mode: 'pointer', uri: '', content_type: 't' } },
    { name: 'unknown top-level key', body: { mode: 'pointer', uri: 'https://e/a', content_type: 't', extra: 'no' } },
  ])('rejects invalid pointer-body shape: $name', async ({ body }) => {
    const res = await postPointer(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error_code: string };
    expect(json.error_code).toBe('invalid_pointer_body');
  });
});

describe('POST /v1/storage/artifacts — managed mode', () => {
  it('uploads bytes and returns 201 + content_hash when disclose_content_hash=true', async () => {
    const payload = Buffer.from('managed-bytes');
    const res = await postManaged(
      payload,
      { 'Content-Length': String(payload.length) },
      `?mode=managed&disclose_content_hash=true`,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mode).toBe('managed');
    expect(typeof body.content_hash).toBe('string');
    expect(body).not.toHaveProperty('stored_hash');
  });

  it('omits content_hash on the wire when disclose_content_hash is not set', async () => {
    const payload = Buffer.from('private-bytes');
    const res = await postManaged(payload, { 'Content-Length': String(payload.length) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('content_hash');
  });

  it('returns 411 when Content-Length is missing for a managed upload', async () => {
    // Use node:http so the request can be sent with
    // `Transfer-Encoding: chunked` and NO `Content-Length` header.
    // The global `fetch()` either adds Content-Length automatically
    // or refuses the request, both of which would make this test
    // unable to prove the 411 envelope deterministically.
    const port = Number(new URL(localFsHandle.baseUrl).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: `/v1/storage/artifacts?mode=managed`,
        method: 'POST',
        headers: {
          ...authHeaderWithUser(USER_A),
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked',
        },
      }, (res) => {
        // Drain the response so the socket can close.
        res.on('data', () => undefined);
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.write('chunk1');
      req.end();
    });
    expect(status).toBe(411);
  });

  it('returns 413 when the managed body exceeds the cap', async () => {
    const oversize = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    const res = await postManaged(
      oversize,
      { 'Content-Length': String(oversize.length) },
    );
    expect(res.status).toBe(413);
  });

  it('rejects an X-AtomicMemory-Metadata header that exceeds the 8 KiB encoded cap', async () => {
    const oversizeEncoded = 'A'.repeat(8 * 1024 + 4);
    const payload = Buffer.from('x');
    const res = await postManaged(
      payload,
      {
        'Content-Length': String(payload.length),
        'X-AtomicMemory-Metadata': oversizeEncoded,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_metadata_header');
  });

  it('rejects an invalid disclose_content_hash value with 400 invalid_disclose_content_hash', async () => {
    const payload = Buffer.from('x');
    const res = await postManaged(
      payload,
      { 'Content-Length': String(payload.length) },
      `?mode=managed&disclose_content_hash=maybe`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('invalid_disclose_content_hash');
  });

  it('accepts a valid X-AtomicMemory-Metadata header round-trip', async () => {
    const encoded = Buffer.from(JSON.stringify({ filename: 'a.pdf' })).toString('base64');
    const payload = Buffer.from('valid');
    const res = await postManaged(
      payload,
      {
        'Content-Length': String(payload.length),
        'X-AtomicMemory-Metadata': encoded,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { metadata: Record<string, string> };
    expect(body.metadata).toEqual({ filename: 'a.pdf' });
  });
});

describe('POST /v1/storage/artifacts — Filecoin direct carve-out', () => {
  it('returns 501 filecoin_direct_storage_not_yet_supported for managed mode', async () => {
    const payload = Buffer.from('to-filecoin');
    const res = await fetch(
      `${filecoinHandle.baseUrl}/v1/storage/artifacts?mode=managed`,
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
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('filecoin_direct_storage_not_yet_supported');
  });

  it('allows pointer-mode put against Filecoin (metadata-only, no backend call)', async () => {
    const res = await fetch(
      `${filecoinHandle.baseUrl}/v1/storage/artifacts`,
      {
        method: 'POST',
        headers: {
          ...authHeaderWithUser(USER_A),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'pointer',
          uri: 'ipfs://bafyplaceholder',
          content_type: 'application/octet-stream',
        }),
      },
    );
    expect(res.status).toBe(201);
  });
});

describe('GET / HEAD / DELETE / verify', () => {
  async function createPointer(userId: string = USER_A): Promise<string> {
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts`,
      {
        method: 'POST',
        headers: {
          ...authHeaderWithUser(userId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'pointer',
          uri: 'https://example.com/x',
          content_type: 'text/plain',
        }),
      },
    );
    const body = (await res.json()) as { artifact_id: string };
    return body.artifact_id;
  }

  async function createManaged(userId: string = USER_A): Promise<string> {
    const payload = Buffer.from('managed');
    const res = await postManaged(
      payload,
      { 'Content-Length': String(payload.length) },
      `?mode=managed`,
      userId,
    );
    const body = (await res.json()) as { artifact_id: string };
    return body.artifact_id;
  }

  it('GET /:id returns the artifact for the owner and 404 for a cross-user caller', async () => {
    const id = await createPointer(USER_A);
    const own = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(own.status).toBe(200);
    const other = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}`,
      { headers: authHeaderWithUser(USER_B) },
    );
    expect(other.status).toBe(404);
  });

  it('GET /:id/content returns bytes for managed, 409 pointer_content_not_managed for pointer', async () => {
    const managedId = await createManaged();
    const ok = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${managedId}/content`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('managed');
    const pointerId = await createPointer();
    const ptr = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${pointerId}/content`,
      { headers: authHeaderWithUser(USER_A) },
    );
    expect(ptr.status).toBe(409);
    const body = (await ptr.json()) as { error_code: string };
    expect(body.error_code).toBe('pointer_content_not_managed');
  });

  it('HEAD /:id emits the X-AtomicMemory-* response headers', async () => {
    const id = await createManaged();
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}`,
      { method: 'HEAD', headers: authHeaderWithUser(USER_A) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-atomicmemory-artifact-id')).toBe(id);
    expect(res.headers.get('x-atomicmemory-storage-mode')).toBe('managed');
    expect(res.headers.get('x-atomicmemory-provider')).toBe('local_fs');
  });

  it('DELETE rejects `force` and returns 409 artifact_in_use without policy=with_documents', async () => {
    const id = await createPointer();
    // Link a document to trigger the reference-count gate.
    const { upsertRawSource, registerRawDocument } = await import('../../db/raw-document-repository.js');
    const source = await upsertRawSource(pool, { userId: USER_A, sourceSite: 'drive', provider: 'google-drive' });
    const reg = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: source.id,
      externalId: 'ext-for-delete',
      storageMode: 'pointer_only',
      externalUri: 'https://example.com/x',
    });
    await pool.query(`UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`, [id, reg.document.id]);
    // force is explicitly unsupported.
    const forceRes = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}?force=true`,
      { method: 'DELETE', headers: authHeaderWithUser(USER_A) },
    );
    expect(forceRes.status).toBe(400);
    // Default policy returns 409 when references exist.
    const inUse = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}`,
      { method: 'DELETE', headers: authHeaderWithUser(USER_A) },
    );
    expect(inUse.status).toBe(409);
    const body = (await inUse.json()) as { error_code: string; referenced_by_document_count: number };
    expect(body.error_code).toBe('artifact_in_use');
    expect(body.referenced_by_document_count).toBe(1);
    // Cascade works.
    const cascade = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}?policy=with_documents`,
      { method: 'DELETE', headers: authHeaderWithUser(USER_A) },
    );
    expect(cascade.status).toBe(200);
  });

  it('verify on a pointer artifact returns kind=unsupported (no URI probe)', async () => {
    const id = await createPointer();
    const res = await fetch(
      `${localFsHandle.baseUrl}/v1/storage/artifacts/${id}/verify`,
      { method: 'POST', headers: authHeaderWithUser(USER_A) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('unsupported');
  });
});
