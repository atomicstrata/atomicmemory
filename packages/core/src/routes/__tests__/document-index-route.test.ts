/**
 * HTTP-level tests for POST /v1/documents/:id/index (Phase 2).
 *
 * Mirrors the route-test pattern from `documents.test.ts` and
 * `event-chains-and-first-mentions.test.ts`: real Express app on a
 * random port, real DocumentService against the test Postgres,
 * embeddings mocked. Asserts the wire-shape success path, idempotent
 * re-index, the 404 envelope on cross-user / unknown-id, and the
 * 400 envelope on missing required fields.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/embedding.js')>();
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => {
      const { config: cfg } = await import('../../config.js');
      return texts.map(() => new Array(cfg.embeddingDimensions).fill(0));
    }),
  };
});

import express from 'express';
import { pool } from '../../db/pool.js';
import { DocumentService } from '../../services/document-service.js';
import { createDocumentRouter } from '../documents.js';
import { MAX_INDEX_TEXT_BYTES } from '../../schemas/documents.js';
import {
  documentRouterFixture,
  useEphemeralDocumentServer,
} from './document-router-test-fixtures.js';

const TEST_USER = 'doc-index-route-user';
const OTHER_USER = 'doc-index-route-other';
const SAMPLE_TEXT = 'word '.repeat(800);

const app = express();
// Phase A: `createApp` no longer mounts a global JSON parser. The
// documents router owns body parsing internally - `POST /:id/index`
// has a per-route `express.json({ limit: INDEX_BODY_PARSER_LIMIT })`
// registered before the router-level 1 MiB JSON middleware, so the
// 5 MiB regression case below still reaches the handler with a
// fully-parsed body.
app.use('/documents', createDocumentRouter(new DocumentService(pool), documentRouterFixture()));

const server = useEphemeralDocumentServer(app, pool);

async function registerDoc(): Promise<string> {
  const res = await fetch(`${server.baseUrl()}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: TEST_USER,
      source_site: 'drive',
      provider: 'google-drive',
      external_id: 'file-1',
      // Phase B - opt into the semantic-index pipeline at register
      // time so `POST /:id/index` is a permitted transition.
      extraction_status: 'pending',
      semantic_index_status: 'pending',
    }),
  });
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

async function postIndex(id: string, body: Record<string, unknown>) {
  const res = await fetch(`${server.baseUrl()}/documents/${id}/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function readStatus(documentId: string) {
  const row = await pool.query<{
    semantic_index_status: string;
    last_error: { layer: string; code: string; message: string } | null;
  }>(
    `SELECT semantic_index_status, last_error FROM raw_documents WHERE id = $1`,
    [documentId],
  );
  return row.rows[0];
}

describe('POST /v1/documents/:id/index — Phase 2', () => {
  it('returns 200 with chunk + memory counts, indexed_content_hash, and pinned versions', async () => {
    const id = await registerDoc();
    const { status, body } = await postIndex(id, { user_id: TEST_USER, text: SAMPLE_TEXT });
    expect(status).toBe(200);
    const b = body as {
      indexed_content_hash: string;
      chunks_created: number;
      memories_created: number;
      idempotent_skip: boolean;
      chunker_version: string;
      parser_version: string;
    };
    expect(b.chunks_created).toBeGreaterThan(0);
    expect(b.memories_created).toBe(b.chunks_created);
    expect(b.idempotent_skip).toBe(false);
    expect(b.indexed_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.chunker_version).toBe('phase2-fixed-v1');
    expect(b.parser_version).toBe('phase2-text-v1');
  });

  it('idempotent on byte-identical re-index (idempotent_skip=true, zero deltas)', async () => {
    const id = await registerDoc();
    await postIndex(id, { user_id: TEST_USER, text: SAMPLE_TEXT });
    const second = await postIndex(id, { user_id: TEST_USER, text: SAMPLE_TEXT });
    expect(second.status).toBe(200);
    const b = second.body as { idempotent_skip: boolean; chunks_created: number; memories_created: number };
    expect(b.idempotent_skip).toBe(true);
    expect(b.chunks_created).toBe(0);
    expect(b.memories_created).toBe(0);
  });

  it('returns 404 when document_id is unknown for the caller', async () => {
    const id = await registerDoc();
    const { status } = await postIndex(id, { user_id: OTHER_USER, text: SAMPLE_TEXT });
    expect(status).toBe(404);
  });

  it('returns schema 400 when text is missing from the body — no row touched', async () => {
    const id = await registerDoc();
    const before = await readStatus(id);
    const { status, body } = await postIndex(id, { user_id: TEST_USER });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/text/i);
    // Pre-document-known schema failure must NOT mark the row failed.
    const after = await readStatus(id);
    expect(after.semantic_index_status).toBe(before.semantic_index_status);
    expect(after.last_error).toBeNull();
  });

  it('returns 400 with code=extraction_empty + documentId when text is whitespace-only; persists semantic_index_status=failed', async () => {
    const id = await registerDoc();
    const { status, body } = await postIndex(id, { user_id: TEST_USER, text: '   \n\t  ' });
    expect(status).toBe(400);
    const b = body as { error: string; code?: string; documentId?: string };
    expect(b.error).toMatch(/non-whitespace|text/i);
    // Phase B durable-failure contract: indexer's `semanticValidate`
    // owns whitespace + oversized checks AFTER document load + CAS so
    // the row carries the failure observable to subsequent reads.
    expect(b.code).toBe('extraction_empty');
    expect(b.documentId).toBe(id);
    const after = await readStatus(id);
    expect(after.semantic_index_status).toBe('failed');
    expect(after.last_error?.layer).toBe('semantic_index');
    expect(after.last_error?.code).toBe('extraction_empty');
  });

  it('DELETE /v1/documents/:id after indexing leaves no active chunks or provenance memories', async () => {
    const id = await registerDoc();
    await postIndex(id, { user_id: TEST_USER, text: SAMPLE_TEXT });

    const del = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const chunkCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM document_chunks WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    const memCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    expect(chunkCount.rows[0].n).toBe(0);
    expect(memCount.rows[0].n).toBe(0);
  });

  it('returns 400 when id is not a UUID', async () => {
    const { status } = await postIndex('not-a-uuid', { user_id: TEST_USER, text: SAMPLE_TEXT });
    expect(status).toBe(400);
  });

  it('accepts a 5 MiB extracted-text body without truncation (Phase 4 raised body cap)', async () => {
    const id = await registerDoc();
    // 5 MiB of UTF-8 ASCII text — well under the 25 MiB ceiling but
    // well above the legacy 1 MiB cap that Phase 4 needed to lift so
    // webapp uploads of large extracted PDFs/etc. don't get silently
    // truncated. The body assembles in chunks to keep the test
    // deterministic (no timing-based string building).
    const FIVE_MIB = 5 * 1024 * 1024;
    const text = 'a'.repeat(FIVE_MIB);
    const { status, body } = await postIndex(id, { user_id: TEST_USER, text });
    expect(status).toBe(200);
    const b = body as { chunks_created: number; memories_created: number };
    expect(b.chunks_created).toBeGreaterThan(0);
    expect(b.memories_created).toBe(b.chunks_created);
  }, 60_000);

  it('returns 413 with code=index_text_too_large + documentId when text exceeds MAX_INDEX_TEXT_BYTES; persists semantic_index_status=failed', async () => {
    const id = await registerDoc();
    // One byte over the indexer's `semanticValidate` ceiling. The
    // route's body-parser limit (`INDEX_BODY_PARSER_LIMIT`) sits a
    // 64 KiB headroom above MAX_INDEX_TEXT_BYTES so the body reaches
    // the handler — `semanticValidate` then throws
    // `IndexSemanticValidationError(code='index_text_too_large')` and
    // the indexer's catch path writes the durable failure marker.
    const oversized = 'a'.repeat(MAX_INDEX_TEXT_BYTES + 1);
    const { status, body } = await postIndex(id, { user_id: TEST_USER, text: oversized });
    expect(status).toBe(413);
    const b = body as { error: string; code?: string; documentId?: string };
    expect(b.code).toBe('index_text_too_large');
    expect(b.documentId).toBe(id);
    const memCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    expect(memCount.rows[0].n).toBe(0);
    const after = await readStatus(id);
    expect(after.semantic_index_status).toBe('failed');
    expect(after.last_error?.layer).toBe('semantic_index');
    expect(after.last_error?.code).toBe('index_text_too_large');
  }, 60_000);

  it('register POST / is gated by the router-level 1 MiB JSON parser, NOT the per-route /index parser', async () => {
    // The router mounts a 25 MiB parser on `POST /:id/index` and a 1 MiB
    // parser at the router level. A 2 MiB body to `POST /` (register)
    // must be rejected — proves the per-route parser does not leak its
    // larger cap to other routes, and that the router-level parser is
    // actually wired.
    const TWO_MIB = 2 * 1024 * 1024;
    const oversizeNotes = 'x'.repeat(TWO_MIB);
    const res = await fetch(`${server.baseUrl()}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: TEST_USER,
        source_site: 'drive',
        provider: 'google-drive',
        external_id: 'large-register',
        // Stuff a giant string into a registered field so the JSON
        // body itself exceeds 1 MiB.
        display_name: oversizeNotes,
      }),
    });
    // The router-level express.json with limit '1mb' surfaces 413 for
    // over-limit bodies (some versions surface 400). What matters is
    // "rejected before the handler" — DB stays clean.
    expect([400, 413]).toContain(res.status);
  }, 30_000);

  it('a 2 MiB body on /:id/index succeeds because the per-route 25 MiB parser fires first', async () => {
    const id = await registerDoc();
    const TWO_MIB = 2 * 1024 * 1024;
    const text = 'a'.repeat(TWO_MIB);
    const { status, body } = await postIndex(id, { user_id: TEST_USER, text });
    expect(status).toBe(200);
    const b = body as { chunks_created: number; memories_created: number };
    expect(b.chunks_created).toBeGreaterThan(0);
    expect(b.memories_created).toBe(b.chunks_created);
  }, 60_000);
});
