/**
 * HTTP-level tests for /v1/documents pointer-only registration.
 *
 * Mirrors `event-chains-and-first-mentions.test.ts`: an Express app is
 * built with `createDocumentRouter`, a real `DocumentService` wired
 * against the test Postgres, and `fetch` drives the registered routes.
 * Embeddings/LLM are not invoked by registration, so no mocks are needed.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import { pool } from '../../db/pool.js';
import { DocumentService } from '../../services/document-service.js';
import { createDocumentRouter } from '../documents.js';
import {
  documentRouterFixture,
  useEphemeralDocumentServer,
} from './document-router-test-fixtures.js';
import { REAL_PIECE_CID_A } from '../../storage/__tests__/filecoin-cid-fixtures.js';

const TEST_USER = 'documents-route-test-user';
const OTHER_USER = 'documents-route-test-other';

const app = express();
// `createApp` no longer mounts a global JSON parser; the
// documents router owns its own body parsing internally. Tests follow
// that contract - no upstream `express.json()`.
app.use('/documents', createDocumentRouter(new DocumentService(pool), documentRouterFixture()));

const server = useEphemeralDocumentServer(app, pool);

interface DocumentBody {
  id: string;
  user_id: string;
  storage_mode: string;
  storage_uri: string | null;
  storage_provider: string | null;
  raw_storage_status: string;
}

interface RegisterResponse {
  document: DocumentBody;
  created: boolean;
}

async function registerDoc(body: Record<string, unknown>): Promise<{ status: number; body: RegisterResponse | { error: string } }> {
  const res = await fetch(`${server.baseUrl()}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as RegisterResponse | { error: string } };
}

describe('POST /v1/documents — registration', () => {
  it('returns 201 with id on first registration', async () => {
    const { status, body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
      external_uri: 'https://drive.google.com/file/d/abc',
      display_name: 'plan.md',
      mime_type: 'text/markdown',
    });
    expect(status).toBe(201);
    expect((body as RegisterResponse).created).toBe(true);
    expect((body as RegisterResponse).document.user_id).toBe(TEST_USER);
  });

  it('returns 200 with the same id on idempotent re-registration', async () => {
    const payload = { user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'file-1' };
    const first = await registerDoc(payload);
    const second = await registerDoc(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((first.body as RegisterResponse).document.id).toBe((second.body as RegisterResponse).document.id);
    expect((second.body as RegisterResponse).created).toBe(false);
  });

  it('returns 400 when storage_mode is managed_blob', async () => {
    const { status, body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
      storage_mode: 'managed_blob',
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/pointer_only/i);
  });

  it('returns 400 when required fields are missing', async () => {
    const { status, body } = await registerDoc({ user_id: TEST_USER, source_site: 'drive' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/provider|external_id/i);
  });

  it('pointer-only invariant: storage_uri / storage_provider are NULL on the wire', async () => {
    const { body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
    });
    const doc = (body as RegisterResponse).document;
    expect(doc.storage_mode).toBe('pointer_only');
    expect(doc.storage_uri).toBeNull();
    expect(doc.storage_provider).toBeNull();
    expect(doc.raw_storage_status).toBe('pointer_recorded');
  });
});

describe('GET /v1/documents/:id', () => {
  it('returns 404 when fetched by a different user', async () => {
    const { body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
    });
    const id = (body as RegisterResponse).document.id;
    const res = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${OTHER_USER}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 when id is not a UUID', async () => {
    const res = await fetch(`${server.baseUrl()}/documents/not-a-uuid?user_id=${TEST_USER}`);
    expect(res.status).toBe(400);
  });

  it('emits raw_storage_metadata on the wire through formatPublicRawStorageMetadata redaction', async () => {
    // `formatRawDocument` projects `raw_storage_metadata` through the
    // public allowlist. Freshly-registered rows are pointer-only →
    // `{}`. A server-side UPDATE that drops an internal upload
    // shape into the column gets STRIPPED of `upload_result` + AES-GCM
    // internals before reaching the wire.
    const { body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'metadata-projection',
    });
    const id = (body as RegisterResponse).document.id;
    const pointerOnly = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    expect(pointerOnly.status).toBe(200);
    const pointerOnlyBody = (await pointerOnly.json()) as { raw_storage_metadata: unknown };
    expect(pointerOnlyBody.raw_storage_metadata).toEqual({});

    // Plant an internal-shape metadata blob — codec internals
    // (nonce/tag/key_id), filecoin allowlisted + unknown keys,
    // upload_result internal sidecar.
    const internal = {
      codec: {
        name: 'aes_gcm',
        version: 1,
        nonce: 'PLANTED-NONCE',
        tag: 'PLANTED-TAG',
        key_id: 'v1',
        encoded_content_hash: 'planted-hex',
      },
      filecoin: {
        ipfs_cid: 'bafy' + 'a'.repeat(55),
        piece_cid: REAL_PIECE_CID_A,
        copies: [{ provider_id: 'f01', status: 'active' }],
        // Legacy onramp + credential-shaped fields that MUST NOT
        // reach the wire.
        gateway_url: 'PLANTED-GATEWAY',
        onramp: 'PLANTED-ONRAMP',
        onramp_status: 'PLANTED-STATUS',
        internal_billing_secret: 'PLANTED-SECRET',
      },
      upload_result: { stored_status: 'pending' },
    };
    await pool.query(
      `UPDATE raw_documents SET raw_storage_metadata = $1::jsonb WHERE id = $2`,
      [JSON.stringify(internal), id],
    );
    const promoted = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    const promotedRaw = await promoted.text();
    // Sensitive internals must not appear ANYWHERE in the response.
    expect(promotedRaw).not.toContain('PLANTED-NONCE');
    expect(promotedRaw).not.toContain('PLANTED-TAG');
    expect(promotedRaw).not.toContain('PLANTED-SECRET');
    expect(promotedRaw).not.toContain('PLANTED-GATEWAY');
    expect(promotedRaw).not.toContain('PLANTED-ONRAMP');
    expect(promotedRaw).not.toContain('PLANTED-STATUS');
    expect(promotedRaw).not.toContain('upload_result');
    expect(promotedRaw).not.toContain('stored_status');
    expect(promotedRaw).not.toContain('encoded_content_hash');
    const promotedBody = JSON.parse(promotedRaw) as { raw_storage_metadata: unknown };
    expect(promotedBody.raw_storage_metadata).toEqual({
      codec: { name: 'aes_gcm', version: 1 },
      filecoin: {
        ipfs_cid: 'bafy' + 'a'.repeat(55),
        piece_cid: REAL_PIECE_CID_A,
        copy_count: 1,
        provider_ids: ['f01'],
        copy_statuses: ['active'],
      },
    });
  });
});

describe('DELETE /v1/documents/:id', () => {
  it('soft-deletes; second call is idempotent with already_deleted=true', async () => {
    const { body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
    });
    const id = (body as RegisterResponse).document.id;
    const first = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`, { method: 'DELETE' });
    expect(first.status).toBe(200);
    const second = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`, { method: 'DELETE' });
    const secondBody = (await second.json()) as { success: boolean; already_deleted: boolean };
    expect(secondBody.already_deleted).toBe(true);
  });

  it('GET after DELETE returns 404', async () => {
    const { body } = await registerDoc({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
    });
    const id = (body as RegisterResponse).document.id;
    await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`, { method: 'DELETE' });
    const res = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/documents/list', () => {
  it('lists active documents for a user, filtered by source_site', async () => {
    await registerDoc({ user_id: TEST_USER, source_site: 'drive', provider: 'gd', external_id: 'a' });
    await registerDoc({ user_id: TEST_USER, source_site: 'drive', provider: 'gd', external_id: 'b' });
    await registerDoc({ user_id: TEST_USER, source_site: 'webapp-file', provider: 'mu', external_id: 'c' });
    const res = await fetch(`${server.baseUrl()}/documents/list?user_id=${TEST_USER}&source_site=drive`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: DocumentBody[]; count: number };
    expect(body.count).toBe(2);
    expect(body.documents.every(d => d.user_id === TEST_USER)).toBe(true);
  });
});

describe('GET /v1/documents/limits', () => {
  it('returns the composition-time snapshot of byte caps and raw_storage capability', async () => {
    const res = await fetch(`${server.baseUrl()}/documents/limits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      raw_upload_max_bytes: number;
      index_max_text_bytes: number;
      raw_storage: { enabled: boolean; mode: string; reason?: string };
    };
    expect(body.raw_upload_max_bytes).toBe(1024 * 1024);
    expect(body.index_max_text_bytes).toBe(25 * 1024 * 1024);
    expect(body.raw_storage.enabled).toBe(false);
    expect(body.raw_storage.mode).toBe('pointer_only');
    expect(body.raw_storage.reason).toBe('test fixture');
  });

  it('is not shadowed by GET /:id — the literal "limits" path takes precedence', async () => {
    // If /limits were registered after /:id, Express would route this
    // to the get-by-id handler and reject "limits" as a non-UUID.
    const res = await fetch(`${server.baseUrl()}/documents/limits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { raw_upload_max_bytes: number };
    // Real /limits payload, not the get-by-id 400/404 envelope.
    expect(typeof body.raw_upload_max_bytes).toBe('number');
  });
});

describe('POST /v1/documents — registration trust model', () => {
  it('accepts safe initial states (extraction_status=pending, semantic_index_status=pending) on the wire', async () => {
    const { status, body } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-pending',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    expect(status).toBe(201);
    const doc = (body as RegisterResponse).document as DocumentBody & {
      extraction_status: string; semantic_index_status: string; last_error: unknown;
    };
    expect(doc.extraction_status).toBe('pending');
    expect(doc.semantic_index_status).toBe('pending');
    expect(doc.last_error).toBeNull();
  });

  it('accepts extraction_status=unsupported (caller flagged a non-extractable file)', async () => {
    const { status, body } = await registerDoc({
      user_id: TEST_USER, source_site: 'webapp-file', provider: 'manual-upload', external_id: 'phase-b-unsupported',
      extraction_status: 'unsupported', semantic_index_status: 'not_required',
    });
    expect(status).toBe(201);
    const doc = (body as RegisterResponse).document as DocumentBody & {
      extraction_status: string; semantic_index_status: string;
    };
    expect(doc.extraction_status).toBe('unsupported');
    expect(doc.semantic_index_status).toBe('not_required');
  });

  it('rejects service-owned extraction_status values: complete', async () => {
    const { status } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-cmpl',
      extraction_status: 'complete',
    });
    expect(status).toBe(400);
  });

  it('rejects service-owned extraction_status values: failed', async () => {
    const { status } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-fail',
      extraction_status: 'failed',
    });
    expect(status).toBe(400);
  });

  it('rejects service-owned extraction_status values: running', async () => {
    const { status } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-run',
      extraction_status: 'running',
    });
    expect(status).toBe(400);
  });

  it('rejects last_error supplied on the register body (service-owned only)', async () => {
    const { status } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-le',
      // Try to smuggle a failure envelope into the row at register time.
      last_error: { layer: 'semantic_index', code: 'forced', message: 'no', occurred_at: new Date().toISOString() },
    });
    expect(status).toBe(400);
  });

  it('default response shape exposes extraction_status, semantic_index_status, last_error (snake_case)', async () => {
    const { body } = await registerDoc({
      user_id: TEST_USER, source_site: 'drive', provider: 'google-drive', external_id: 'phase-b-default',
    });
    const doc = (body as RegisterResponse).document as DocumentBody & {
      extraction_status: string; semantic_index_status: string; last_error: unknown;
    };
    // Default column values for a row that doesn't opt into the pipeline.
    expect(doc.extraction_status).toBe('not_required');
    expect(doc.semantic_index_status).toBe('not_required');
    expect(doc.last_error).toBeNull();
  });
});
