/**
 * HTTP tests for PUT /v1/documents/:id/raw (Phase 3 managed-blob upload).
 *
 * Real Express app with a real DocumentService against the test
 * Postgres + a temporary `local_fs` adapter. Asserts the wire shape on
 * the success/idempotent paths, the 404 envelope, and that the DB row
 * is promoted to managed_blob/blob_stored. The 503 path is covered by
 * a separate test that constructs the service without a store.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { DocumentService } from '../../services/document-service.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { createDocumentRouter } from '../documents.js';
import { documentRouterFixture } from './document-router-test-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const TEST_USER = 'doc-raw-route-user';
const OTHER_USER = 'doc-raw-route-other';
const PAYLOAD = Buffer.from('hello managed blob', 'utf8');

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let storageRoot: string;
const app = express();
// Phase A: documents router owns body parsing internally; no upstream JSON parser.

async function registerDoc(): Promise<string> {
  const res = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: TEST_USER,
      source_site: 'webapp-file',
      provider: 'manual-upload',
      external_id: 'file-1',
    }),
  });
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

async function putRaw(id: string, query: string, body: Buffer | string) {
  const res = await fetch(`${baseUrl}/documents/${id}/raw?${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: body as unknown as BodyInit,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-raw-route-'));
  const store = new LocalFsRawContentStore({ root: storageRoot });
  const service = new DocumentService(pool, {
    rawContentStore: store,
    config: { rawStoragePrefix: 'test', rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
  });
  app.use(
    '/documents',
    createDocumentRouter(
      service,
      documentRouterFixture({ rawStorage: { enabled: true, mode: 'managed_blob' } }),
    ),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Self-cleanup managed-blob rows so cross-file ordering can't trip a
  // later test's strict Phase-3 deleteAll cleanup path.
  await clearDocumentTables(pool);
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

describe('PUT /v1/documents/:id/raw — managed-blob happy path', () => {
  it('writes the blob and promotes the document to managed_blob/blob_stored', async () => {
    const id = await registerDoc();
    const { status, body } = await putRaw(id, `user_id=${TEST_USER}`, PAYLOAD);
    expect(status).toBe(200);
    const b = body as {
      storage_mode: string;
      raw_storage_status: string;
      content_hash: string;
      size_bytes: number;
      storage_provider: string;
      storage_uri: string;
      idempotent_skip: boolean;
    };
    expect(b.storage_mode).toBe('managed_blob');
    expect(b.raw_storage_status).toBe('blob_stored');
    expect(b.storage_provider).toBe('local_fs');
    // PII-safe key shape: `<prefix>/s/<hmac-hex32>/...` — plaintext
    // userId MUST NOT appear in the URI.
    expect(b.storage_uri).toMatch(/^local-fs:\/\/test\/s\/[0-9a-f]{32}\//);
    expect(b.storage_uri).not.toContain(TEST_USER);
    expect(b.size_bytes).toBe(PAYLOAD.length);
    expect(b.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.idempotent_skip).toBe(false);

    // Verify the bytes actually landed on disk.
    const relKey = b.storage_uri.replace('local-fs://', '');
    const onDisk = await readFile(join(storageRoot, relKey));
    expect(Buffer.compare(onDisk, PAYLOAD)).toBe(0);

    // Verify the DB row is promoted.
    const docRow = await pool.query<{
      storage_mode: string;
      raw_storage_status: string;
      content_hash: string;
    }>(`SELECT storage_mode, raw_storage_status, content_hash FROM raw_documents WHERE id = $1`, [id]);
    expect(docRow.rows[0]).toMatchObject({
      storage_mode: 'managed_blob',
      raw_storage_status: 'blob_stored',
      content_hash: b.content_hash,
    });
  });

  it('idempotent on byte-identical re-upload (idempotent_skip=true)', async () => {
    const id = await registerDoc();
    const first = await putRaw(id, `user_id=${TEST_USER}`, PAYLOAD);
    const second = await putRaw(id, `user_id=${TEST_USER}`, PAYLOAD);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const b = second.body as { idempotent_skip: boolean; storage_uri: string };
    expect(b.idempotent_skip).toBe(true);
    expect(b.storage_uri).toBe((first.body as { storage_uri: string }).storage_uri);
  });
});

describe('PUT /v1/documents/:id/raw — managed-blob slot is immutable per row', () => {
  it('returns 409 when the same document is re-uploaded with different bytes; DB row + on-disk blob unchanged', async () => {
    const id = await registerDoc();
    const firstBytes = Buffer.from('original managed bytes', 'utf8');
    const secondBytes = Buffer.from('different managed bytes!', 'utf8');

    const first = await putRaw(id, `user_id=${TEST_USER}`, firstBytes);
    expect(first.status).toBe(200);
    const firstBody = first.body as { storage_uri: string; content_hash: string };

    const conflict = await putRaw(id, `user_id=${TEST_USER}`, secondBytes);
    expect(conflict.status).toBe(409);
    expect((conflict.body as { error: string }).error).toMatch(/already has a managed blob/i);

    // DB row still references the first upload's bytes.
    const row = await pool.query<{ storage_uri: string; content_hash: string }>(
      `SELECT storage_uri, content_hash FROM raw_documents WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].storage_uri).toBe(firstBody.storage_uri);
    expect(row.rows[0].content_hash).toBe(firstBody.content_hash);

    // First-upload blob is still on disk; the conflicting second blob
    // was never written (no second key under the document's prefix).
    const relKey = firstBody.storage_uri.replace('local-fs://', '');
    const onDisk = await readFile(join(storageRoot, relKey));
    expect(Buffer.compare(onDisk, firstBytes)).toBe(0);
    const docDir = relKey.substring(0, relKey.lastIndexOf('/'));
    expect(await readdir(join(storageRoot, docDir))).toHaveLength(1);
  });
});

describe('PUT /v1/documents/:id/raw — error envelopes', () => {
  it('returns 404 when document_id is unknown for the caller', async () => {
    const id = await registerDoc();
    const { status } = await putRaw(id, `user_id=${OTHER_USER}`, PAYLOAD);
    expect(status).toBe(404);
  });

  it('returns 400 when body is empty', async () => {
    const id = await registerDoc();
    const { status, body } = await putRaw(id, `user_id=${TEST_USER}`, Buffer.alloc(0));
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/body|required/i);
  });

  it('returns 400 when id is not a UUID', async () => {
    const res = await fetch(`${baseUrl}/documents/not-a-uuid/raw?user_id=${TEST_USER}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: PAYLOAD as unknown as BodyInit,
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 artifact_not_linkable when the prior pointer artifact is mid-delete', async () => {
    // Wire a doc → pointer-artifact link via the repository (the
    // POST /documents path in this test app does not accept
    // `external_uri`), then move the artifact into a delete
    // lifecycle so the Phase β2 swap helper refuses to attach.
    const source = await upsertRawSource(pool, {
      userId: TEST_USER, sourceSite: 'drive', provider: 'google-drive',
    });
    const reg = await registerRawDocument(pool, {
      userId: TEST_USER, rawSourceId: source.id,
      externalId: 'route-not-linkable',
      storageMode: 'pointer_only',
      externalUri: 'https://example.com/route-not-linkable',
    });
    const priorArtifactId = reg.document.storageArtifactId;
    if (priorArtifactId === null) throw new Error('expected pointer artifact link');
    await pool.query(
      `UPDATE storage_artifacts SET status = 'deleting' WHERE id = $1`,
      [priorArtifactId],
    );
    const { status, body } = await putRaw(reg.document.id, `user_id=${TEST_USER}`, PAYLOAD);
    expect(status).toBe(409);
    const b = body as { error_code: string; artifact_id: string; artifact_status: string };
    expect(b.error_code).toBe('artifact_not_linkable');
    expect(b.artifact_id).toBe(priorArtifactId);
    expect(b.artifact_status).toBe('deleting');
  });

  it('returns 503 when managed_blob is disabled (no rawContentStore configured) and writes durable raw_storage_failed + last_error.code=managed_storage_disabled', async () => {
    // Spin up a second app whose service has no store + pointer_only mode.
    const app2 = express();
    const noStoreService = new DocumentService(pool, {
      rawContentStore: null,
      config: { rawStoragePrefix: '', rawStorageMode: 'pointer_only' },
    });
    app2.use('/documents', createDocumentRouter(noStoreService, documentRouterFixture()));
    const srv = app2.listen(0);
    try {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url2 = `http://localhost:${port}`;

      const reg = await fetch(`${url2}/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: TEST_USER, source_site: 'webapp-file', provider: 'manual-upload', external_id: 'no-store',
        }),
      });
      const id = ((await reg.json()) as { document: { id: string } }).document.id;
      const res = await fetch(`${url2}/documents/${id}/raw?user_id=${TEST_USER}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: PAYLOAD as unknown as BodyInit,
      });
      expect(res.status).toBe(503);

      // Phase F regression: the 503 path must leave a durable
      // failure marker on the row so the document is recoverable
      // from `GET /v1/documents/:id` and the
      // `/passport-feed`/`/without-memories` recovery surfaces.
      // Pre-Phase-B this branch returned 503 without writing
      // `raw_storage_failed`, leaving the row stuck pending.
      const row = await pool.query<{
        raw_storage_status: string;
        last_error: { layer: string; code: string } | null;
      }>(
        `SELECT raw_storage_status, last_error FROM raw_documents WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]!.raw_storage_status).toBe('raw_storage_failed');
      expect(row.rows[0]!.last_error?.layer).toBe('raw_storage');
      expect(row.rows[0]!.last_error?.code).toBe('managed_storage_disabled');
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
