/**
 * HTTP-level tests for the Phase C constrained failure-marker
 * routes (`POST /v1/documents/:id/extraction-failure` and
 * `POST /v1/documents/:id/index-failure`).
 *
 * Mirrors the route-test pattern from the other document suites:
 * real Express app on a random port, real `DocumentService` against
 * the test Postgres, fetch-driven. Asserts allowed-state transitions,
 * idempotent retry behaviour, the 409 envelope on invalid source
 * states, schema rejection of unknown error codes, and that the
 * response echoes the persisted row.
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

const TEST_USER = 'doc-failure-marker-user';
const OTHER_USER = 'doc-failure-marker-other';

const app = express();
app.use('/documents', createDocumentRouter(new DocumentService(pool), documentRouterFixture()));

const server = useEphemeralDocumentServer(app, pool);

interface RowSnapshot {
  extraction_status: string;
  semantic_index_status: string;
  raw_storage_status: string;
  last_error: { layer: string; code: string; message: string; occurred_at: string } | null;
}

async function readRow(id: string): Promise<RowSnapshot> {
  const r = await pool.query<RowSnapshot>(
    `SELECT extraction_status, semantic_index_status, raw_storage_status, last_error
       FROM raw_documents WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function registerDoc(opts: {
  externalId: string;
  user?: string;
  extraction_status?: 'pending' | 'not_required' | 'unsupported';
  semantic_index_status?: 'pending' | 'not_required';
}): Promise<string> {
  const res = await fetch(`${server.baseUrl()}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: opts.user ?? TEST_USER,
      source_site: 'webapp-file',
      provider: 'manual-upload',
      external_id: opts.externalId,
      extraction_status: opts.extraction_status,
      semantic_index_status: opts.semantic_index_status,
    }),
  });
  const body = (await res.json()) as { document: { id: string } };
  return body.document.id;
}

/**
 * Most marker tests start from the upload-pipeline default state:
 * registered with `extraction_status='pending'`,
 * `semantic_index_status='pending'`. Wrapping the common opts here
 * keeps the per-test boilerplate to one line.
 */
const seedPendingDoc = (externalId: string) =>
  registerDoc({ externalId, extraction_status: 'pending', semantic_index_status: 'pending' });

/**
 * The marker routes require raw bytes to already be on the row
 * (`raw_storage_status IN ('blob_stored', 'inline_text_stored', 'pointer_recorded')`).
 * Newly-registered Phase B rows default to `'pointer_recorded'`, so
 * the tests below run against pointer_recorded rows unless an
 * individual test bumps `raw_storage_status` directly via SQL.
 */
type FailureMarkerBody = { user_id: string; error_code: string; error_message: string };

async function postFailureMarker(
  endpoint: 'extraction-failure' | 'index-failure',
  id: string,
  body: FailureMarkerBody,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.baseUrl()}/documents/${id}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const postExtractionFailure = (id: string, body: FailureMarkerBody) =>
  postFailureMarker('extraction-failure', id, body);
const postIndexFailure = (id: string, body: FailureMarkerBody) =>
  postFailureMarker('index-failure', id, body);

describe('POST /v1/documents/:id/extraction-failure', () => {
  it('first-time failure from pending + raw stored: persists failed + not_required + last_error', async () => {
    const id = await seedPendingDoc('ext-1');
    const { status, body } = await postExtractionFailure(id, {
      user_id: TEST_USER,
      error_code: 'parser_threw',
      error_message: 'mammoth threw on row 17',
    });
    expect(status).toBe(200);
    const env = body as {
      idempotent: boolean;
      document: { extraction_status: string; semantic_index_status: string; last_error: { layer: string; code: string; message: string } };
    };
    expect(env.idempotent).toBe(false);
    expect(env.document.extraction_status).toBe('failed');
    expect(env.document.semantic_index_status).toBe('not_required');
    expect(env.document.last_error.layer).toBe('extraction');
    expect(env.document.last_error.code).toBe('parser_threw');

    const row = await readRow(id);
    expect(row.extraction_status).toBe('failed');
    expect(row.semantic_index_status).toBe('not_required');
    expect(row.last_error?.code).toBe('parser_threw');
  });

  it('idempotent retry: second call with same code is a no-op (occurred_at unchanged)', async () => {
    const id = await seedPendingDoc('ext-2');
    await postExtractionFailure(id, { user_id: TEST_USER, error_code: 'parser_threw', error_message: 'first' });
    const before = await readRow(id);
    const { status, body } = await postExtractionFailure(id, {
      user_id: TEST_USER,
      error_code: 'parser_threw',
      error_message: 'first', // same code — no row touch
    });
    expect(status).toBe(200);
    expect((body as { idempotent: boolean }).idempotent).toBe(true);
    const after = await readRow(id);
    expect(after.last_error?.occurred_at).toBe(before.last_error?.occurred_at);
  });

  it('different code on already-failed row refreshes last_error but keeps idempotent=true', async () => {
    const id = await seedPendingDoc('ext-3');
    await postExtractionFailure(id, { user_id: TEST_USER, error_code: 'parser_threw', error_message: 'first' });
    const { body } = await postExtractionFailure(id, {
      user_id: TEST_USER,
      error_code: 'parser_oom',
      error_message: 'oom on retry',
    });
    const env = body as { idempotent: boolean; document: { last_error: { code: string; message: string } } };
    expect(env.idempotent).toBe(true);
    expect(env.document.last_error.code).toBe('parser_oom');
    expect(env.document.last_error.message).toBe('oom on retry');
  });

  it('returns 409 when extraction_status is already complete (cannot fail a complete extraction via this endpoint)', async () => {
    const id = await seedPendingDoc('ext-4');
    await pool.query(`UPDATE raw_documents SET extraction_status = 'complete' WHERE id = $1`, [id]);
    const { status, body } = await postExtractionFailure(id, {
      user_id: TEST_USER, error_code: 'parser_threw', error_message: 'too late',
    });
    expect(status).toBe(409);
    const env = body as { error: string; documentId: string; current: { extraction_status: string } };
    expect(env.error).toMatch(/Invalid extraction state/i);
    expect(env.documentId).toBe(id);
    expect(env.current.extraction_status).toBe('complete');
    const row = await readRow(id);
    expect(row.extraction_status).toBe('complete');
  });

  it('returns 409 when raw_storage_status is raw_storage_failed (no raw bytes to fail extraction on)', async () => {
    const id = await seedPendingDoc('ext-5');
    await pool.query(`UPDATE raw_documents SET raw_storage_status = 'raw_storage_failed' WHERE id = $1`, [id]);
    const { status } = await postExtractionFailure(id, {
      user_id: TEST_USER, error_code: 'parser_threw', error_message: '',
    });
    expect(status).toBe(409);
  });

  it('returns 404 for cross-user', async () => {
    const id = await seedPendingDoc('ext-6');
    const { status } = await postExtractionFailure(id, {
      user_id: OTHER_USER, error_code: 'parser_threw', error_message: '',
    });
    expect(status).toBe(404);
  });

  it('returns 400 for an out-of-enum error_code (Zod rejects)', async () => {
    const id = await seedPendingDoc('ext-7');
    const { status } = await postExtractionFailure(id, {
      user_id: TEST_USER, error_code: 'not_in_enum', error_message: '',
    });
    expect(status).toBe(400);
  });

  it('persists a sanitised + truncated error_message (control chars stripped, capped to MAX_LAST_ERROR_MESSAGE_CHARS)', async () => {
    const id = await seedPendingDoc('ext-8');
    const noisy = 'parser threw\n\nat line 7\twith\rNULL bytes  and  ' + 'x'.repeat(2000);
    await postExtractionFailure(id, { user_id: TEST_USER, error_code: 'parser_threw', error_message: noisy });
    const row = await readRow(id);
    expect(row.last_error?.message).not.toMatch(/[\n\r\t]/);
    expect(row.last_error?.message.length).toBeLessThanOrEqual(1000);
  });
});

describe('POST /v1/documents/:id/index-failure', () => {
  it('first-time failure from extraction=complete + semantic=pending: writes failed + last_error', async () => {
    const id = await seedPendingDoc('idx-1');
    // Walk extraction to complete out-of-band so we hit the "normal"
    // branch (not the index_text_too_large shortcut).
    await pool.query(`UPDATE raw_documents SET extraction_status = 'complete' WHERE id = $1`, [id]);
    const { status, body } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'unknown', error_message: 'embedding outage',
    });
    expect(status).toBe(200);
    const env = body as {
      idempotent: boolean;
      document: { extraction_status: string; semantic_index_status: string; last_error: { layer: string; code: string } };
    };
    expect(env.idempotent).toBe(false);
    expect(env.document.extraction_status).toBe('complete');
    expect(env.document.semantic_index_status).toBe('failed');
    expect(env.document.last_error.layer).toBe('semantic_index');
    expect(env.document.last_error.code).toBe('unknown');
  });

  it('atomic shortcut: pending+pending + index_text_too_large -> extraction=complete + semantic=failed', async () => {
    const id = await seedPendingDoc('idx-2');
    const { status, body } = await postIndexFailure(id, {
      user_id: TEST_USER,
      error_code: 'index_text_too_large',
      error_message: 'extracted 30 MiB > 25 MiB cap',
    });
    expect(status).toBe(200);
    const env = body as {
      idempotent: boolean;
      document: { extraction_status: string; semantic_index_status: string; last_error: { layer: string; code: string } };
    };
    expect(env.idempotent).toBe(false);
    expect(env.document.extraction_status).toBe('complete');
    expect(env.document.semantic_index_status).toBe('failed');
    expect(env.document.last_error.code).toBe('index_text_too_large');
    const row = await readRow(id);
    expect(row.extraction_status).toBe('complete');
    expect(row.semantic_index_status).toBe('failed');
  });

  it('returns 409 from pending+pending with code != index_text_too_large', async () => {
    const id = await seedPendingDoc('idx-3');
    const { status, body } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'unknown', error_message: '',
    });
    expect(status).toBe(409);
    expect((body as { error: string }).error).toMatch(/Invalid index state/i);
  });

  it('idempotent retry on already-failed: same code is a no-op', async () => {
    const id = await seedPendingDoc('idx-4');
    await pool.query(`UPDATE raw_documents SET extraction_status = 'complete' WHERE id = $1`, [id]);
    await postIndexFailure(id, { user_id: TEST_USER, error_code: 'unknown', error_message: 'first' });
    const before = await readRow(id);
    const { status, body } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'unknown', error_message: 'first',
    });
    expect(status).toBe(200);
    expect((body as { idempotent: boolean }).idempotent).toBe(true);
    const after = await readRow(id);
    expect(after.last_error?.occurred_at).toBe(before.last_error?.occurred_at);
  });

  it('returns 409 when semantic_index_status is already complete (cannot regress)', async () => {
    const id = await seedPendingDoc('idx-5');
    await pool.query(
      `UPDATE raw_documents SET extraction_status = 'complete', semantic_index_status = 'complete' WHERE id = $1`,
      [id],
    );
    const { status } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'unknown', error_message: '',
    });
    expect(status).toBe(409);
  });

  it('returns 404 for cross-user', async () => {
    const id = await seedPendingDoc('idx-6');
    const { status } = await postIndexFailure(id, {
      user_id: OTHER_USER, error_code: 'index_text_too_large', error_message: '',
    });
    expect(status).toBe(404);
  });

  it('returns 400 for an out-of-enum error_code', async () => {
    const id = await seedPendingDoc('idx-7');
    const { status } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'not_in_enum', error_message: '',
    });
    expect(status).toBe(400);
  });

  it('returns 409 from pending+pending when raw_storage_failed (no raw bytes -> no shortcut)', async () => {
    const id = await seedPendingDoc('idx-8');
    await pool.query(`UPDATE raw_documents SET raw_storage_status = 'raw_storage_failed' WHERE id = $1`, [id]);
    const { status } = await postIndexFailure(id, {
      user_id: TEST_USER, error_code: 'index_text_too_large', error_message: '',
    });
    expect(status).toBe(409);
  });
});
