/**
 * Unit tests for the per-layer status repository helpers (Phase B).
 *
 * Each helper is a single conditional UPDATE on `raw_documents` —
 * tests round-trip a row through every transition and assert the
 * `last_error` scoping rule (success on layer X clears `last_error`
 * only when its existing layer is X, never when the envelope was
 * scoped to a different layer).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../pool.js';
import { clearDocumentTables, setupTestSchema } from './test-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../raw-document-repository.js';
import {
  buildLastError,
  clearLastError,
  MAX_LAST_ERROR_MESSAGE_CHARS,
  markExtractionStatus,
  markRawStorageFailedByDocumentId,
  markSemanticIndexStatus,
  sanitizeLastErrorMessage,
} from '../raw-document-status-repository.js';

const USER = 'status-repo-test-user';

async function seedRow(externalId: string) {
  const src = await upsertRawSource(pool, { userId: USER, sourceSite: 'drive', provider: 'google-drive' });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId,
    extractionStatus: 'pending', semanticIndexStatus: 'pending',
  });
  return reg.document;
}

async function readRow(documentId: string) {
  const row = await pool.query<{
    extraction_status: string;
    semantic_index_status: string;
    raw_storage_status: string;
    last_error: { layer: string; code: string; message: string; occurred_at: string } | null;
  }>(
    `SELECT extraction_status, semantic_index_status, raw_storage_status, last_error
       FROM raw_documents WHERE id = $1`,
    [documentId],
  );
  return row.rows[0];
}

// File-level lifecycle so the second `describe` block (sanitization +
// truncation) can still share the pool without the first describe's
// afterAll closing it out from under us.
beforeAll(async () => { await setupTestSchema(pool); });
beforeEach(async () => { await clearDocumentTables(pool); });
afterAll(async () => { await pool.end(); });

describe('raw-document-status-repository', () => {

  it('markExtractionStatus(failed) writes the layer + last_error envelope', async () => {
    const doc = await seedRow('extr-fail');
    await markExtractionStatus({
      q: pool, userId: USER, documentId: doc.id, status: 'failed',
      lastError: buildLastError('extraction', 'parser_threw', 'PDF parser exploded'),
    });
    const row = await readRow(doc.id);
    expect(row.extraction_status).toBe('failed');
    expect(row.last_error?.layer).toBe('extraction');
    expect(row.last_error?.code).toBe('parser_threw');
    expect(row.last_error?.message).toBe('PDF parser exploded');
    expect(row.last_error?.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('markExtractionStatus(complete) clears extraction-scoped last_error but preserves other layers', async () => {
    const doc = await seedRow('extr-cmpl');
    await markExtractionStatus({
      q: pool, userId: USER, documentId: doc.id, status: 'failed',
      lastError: buildLastError('extraction', 'parser_threw', 'first try'),
    });
    await markExtractionStatus({ q: pool, userId: USER, documentId: doc.id, status: 'complete' });
    const after = await readRow(doc.id);
    expect(after.extraction_status).toBe('complete');
    expect(after.last_error).toBeNull();
  });

  it('markExtractionStatus(complete) does NOT clear last_error scoped to a different layer', async () => {
    const doc = await seedRow('extr-cross');
    // Plant a semantic_index failure first.
    await markSemanticIndexStatus({
      q: pool, userId: USER, documentId: doc.id, status: 'failed',
      lastError: buildLastError('semantic_index', 'unknown', 'embedding outage'),
    });
    // Now flip extraction to complete.
    await markExtractionStatus({ q: pool, userId: USER, documentId: doc.id, status: 'complete' });
    const after = await readRow(doc.id);
    expect(after.extraction_status).toBe('complete');
    expect(after.last_error?.layer).toBe('semantic_index');
    expect(after.last_error?.code).toBe('unknown');
  });

  it('markSemanticIndexStatus(failed) requires a lastError envelope', async () => {
    const doc = await seedRow('semi-fail-no-err');
    await expect(
      markSemanticIndexStatus({ q: pool, userId: USER, documentId: doc.id, status: 'failed' }),
    ).rejects.toThrow(/lastError is required/);
  });

  it('markRawStorageFailedByDocumentId writes raw_storage_failed + scoped last_error', async () => {
    const doc = await seedRow('raw-fail');
    await markRawStorageFailedByDocumentId({
      q: pool, userId: USER, documentId: doc.id,
      lastError: buildLastError('raw_storage', 'managed_storage_disabled', 'pointer_only mode'),
    });
    const row = await readRow(doc.id);
    expect(row.raw_storage_status).toBe('raw_storage_failed');
    expect(row.last_error?.layer).toBe('raw_storage');
    expect(row.last_error?.code).toBe('managed_storage_disabled');
  });

  it('clearLastError only clears when the envelope matches the requested layer', async () => {
    const doc = await seedRow('clear-scoped');
    await markSemanticIndexStatus({
      q: pool, userId: USER, documentId: doc.id, status: 'failed',
      lastError: buildLastError('semantic_index', 'unknown', 'oops'),
    });
    // Wrong layer — no-op.
    await clearLastError({ q: pool, userId: USER, documentId: doc.id, layer: 'extraction' });
    let row = await readRow(doc.id);
    expect(row.last_error?.layer).toBe('semantic_index');
    // Correct layer — cleared.
    await clearLastError({ q: pool, userId: USER, documentId: doc.id, layer: 'semantic_index' });
    row = await readRow(doc.id);
    expect(row.last_error).toBeNull();
  });

  it('user scoping: marker against another user is a no-op (does not mutate the row)', async () => {
    const doc = await seedRow('user-scope');
    const before = await readRow(doc.id);
    await markExtractionStatus({
      q: pool, userId: 'someone-else', documentId: doc.id, status: 'failed',
      lastError: buildLastError('extraction', 'parser_threw', 'cross-user attempt'),
    });
    const after = await readRow(doc.id);
    expect(after.extraction_status).toBe(before.extraction_status);
    expect(after.last_error).toBeNull();
  });
});

describe('sanitizeLastErrorMessage / buildLastError truncation', () => {
  it('strips ASCII control chars and collapses whitespace runs to single spaces', () => {
    const raw = 'parser threw\n\nat line 7\twith\rNULL bytes  and  spaces';
    expect(sanitizeLastErrorMessage(raw)).toBe(
      'parser threw at line 7 with NULL bytes and spaces',
    );
  });

  it('preserves printable Unicode characters', () => {
    const raw = 'failed: filename "récit.pdf" — 한국어';
    expect(sanitizeLastErrorMessage(raw)).toBe('failed: filename "récit.pdf" — 한국어');
  });

  it('truncates messages longer than the cap to exactly the cap length', () => {
    const raw = 'x'.repeat(MAX_LAST_ERROR_MESSAGE_CHARS * 3);
    const out = sanitizeLastErrorMessage(raw);
    expect(out.length).toBe(MAX_LAST_ERROR_MESSAGE_CHARS);
  });

  it('buildLastError funnels message through sanitization (single helper, single rule)', () => {
    const noisy = `\n\n\nstack:\n  at fn (file.js:10)\n  at gn (file.js:20)\n${'a'.repeat(MAX_LAST_ERROR_MESSAGE_CHARS)}`;
    const env = buildLastError('semantic_index', 'unknown', noisy);
    expect(env.message.length).toBeLessThanOrEqual(MAX_LAST_ERROR_MESSAGE_CHARS);
    expect(env.message).not.toMatch(/[\n\r\t]/);
  });

  it('persisted last_error.message respects the cap end-to-end', async () => {
    const doc = await seedRow('truncation');
    const huge = 'verbatim '.repeat(MAX_LAST_ERROR_MESSAGE_CHARS); // > cap
    await markSemanticIndexStatus({
      q: pool, userId: USER, documentId: doc.id, status: 'failed',
      lastError: buildLastError('semantic_index', 'unknown', huge),
    });
    const row = await readRow(doc.id);
    expect(row.last_error?.message.length).toBeLessThanOrEqual(MAX_LAST_ERROR_MESSAGE_CHARS);
  });
});
