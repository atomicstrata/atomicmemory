/**
 * Phase B status-transition tests for `document-indexer.ts`.
 *
 * These tests live next to `document-indexer.test.ts` (the core
 * happy-path suite) but focus on the per-layer status model: the
 * atomic CAS to `'running'`, the `'failed'` write on prepare/embed
 * throws, retry from `'failed'`, and the start-state guards that
 * surface as `IndexInvalidStateError` / 409.
 *
 * Embeddings are mocked so we can drive the failure path without a
 * real network call. The test pool is `max=1` (pgvector HNSW index
 * deadlock guard); the indexer's catch path is structured to
 * release the in-tx client before issuing the failure-marker write
 * (see `runIndexFlow` in `document-indexer.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const realEmbedTexts = vi.hoisted(() => ({ fn: null as null | (typeof import('../embedding.js'))['embedTexts'] }));
const embedMock = vi.hoisted(() => vi.fn());
vi.mock('../embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../embedding.js')>();
  realEmbedTexts.fn = actual.embedTexts;
  return { ...actual, embedTexts: embedMock };
});

import { pool } from '../../db/pool.js';
import { DocumentService } from '../document-service.js';
import { config } from '../../config.js';
import {
  IndexInvalidStateError,
  IndexSemanticValidationError,
} from '../document-indexer.js';
import { MAX_INDEX_TEXT_BYTES } from '../../schemas/documents.js';
import {
  seedIndexableDoc,
  useDocumentIndexerLifecycle,
} from './document-indexer-test-helpers.js';

useDocumentIndexerLifecycle(pool);

const USER = 'doc-indexer-status-test-user';
const SAMPLE = 'Section header.\n\n' + 'word '.repeat(900);

async function seedDoc(opts: {
  externalId: string;
  extractionStatus?: 'pending' | 'not_required' | 'unsupported';
  semanticIndexStatus?: 'pending' | 'not_required';
}) {
  return seedIndexableDoc(pool, USER, opts);
}

async function readStatus(documentId: string) {
  const row = await pool.query<{
    extraction_status: string;
    semantic_index_status: string;
    last_error: { layer: string; code: string; message: string; occurred_at: string } | null;
    indexed_content_hash: string | null;
  }>(
    `SELECT extraction_status, semantic_index_status, last_error, indexed_content_hash
       FROM raw_documents WHERE id = $1`,
    [documentId],
  );
  return row.rows[0];
}

const service = new DocumentService(pool);

describe('document-indexer — Phase B status transitions', () => {
  beforeEach(() => {
    embedMock.mockReset();
    embedMock.mockImplementation(async (texts: string[]) => texts.map(() => new Array(config.embeddingDimensions).fill(0)));
  });

  it('happy path: pending → complete; last_error stays null; indexed_content_hash recorded', async () => {
    const doc = await seedDoc({ externalId: 'happy-1' });
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.idempotentSkip).toBe(false);
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('complete');
    expect(after.last_error).toBeNull();
    expect(after.indexed_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('embedding failure → durable semantic_index_status=failed + last_error populated; raw row unchanged elsewhere', async () => {
    const doc = await seedDoc({ externalId: 'embed-fail' });
    embedMock.mockRejectedValueOnce(new Error('simulated embedding outage'));
    await expect(service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE })).rejects.toThrow(/embedding outage/);
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('failed');
    expect(after.last_error?.layer).toBe('semantic_index');
    expect(after.last_error?.code).toBe('unknown');
    expect(after.last_error?.message).toMatch(/embedding outage/);
    // No chunks / memories should have been persisted under the running tx.
    const counts = await pool.query<{ chunks: number; memories: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM document_chunks WHERE raw_document_id = $1 AND deleted_at IS NULL) AS chunks,
         (SELECT COUNT(*)::int FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL) AS memories`,
      [doc.id],
    );
    expect(counts.rows[0].chunks).toBe(0);
    expect(counts.rows[0].memories).toBe(0);
  });

  it('retry from failed: re-indexing with valid text lands complete and clears last_error.semantic_index', async () => {
    const doc = await seedDoc({ externalId: 'retry-from-failed' });
    embedMock.mockRejectedValueOnce(new Error('first try fails'));
    await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE }).catch(() => undefined);
    const before = await readStatus(doc.id);
    expect(before.semantic_index_status).toBe('failed');

    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.idempotentSkip).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('complete');
    expect(after.last_error).toBeNull();
  });

  it('rejection from running: seeded `running` row → IndexInvalidStateError; row stays running', async () => {
    const doc = await seedDoc({ externalId: 'running-seed' });
    await pool.query(
      `UPDATE raw_documents SET semantic_index_status = 'running' WHERE id = $1`,
      [doc.id],
    );
    await expect(
      service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE }),
    ).rejects.toBeInstanceOf(IndexInvalidStateError);
    const after = await readStatus(doc.id);
    // Status untouched; the catch-path deliberately does NOT mark
    // `running` rows failed (would clobber another writer's flow).
    expect(after.semantic_index_status).toBe('running');
    expect(after.last_error).toBeNull();
  });

  it('rejection from not_required: row registered with semantic_index_status=not_required → 409 IndexInvalidStateError', async () => {
    const doc = await seedDoc({ externalId: 'not-required', semanticIndexStatus: 'not_required' });
    const err = await service
      .indexText({ userId: USER, documentId: doc.id, text: SAMPLE })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(IndexInvalidStateError);
    expect((err as IndexInvalidStateError).currentStatus).toBe('not_required');
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('not_required');
    expect(after.last_error).toBeNull();
  });

  it('idempotent skip on complete + same hash: no DB writes; status stays complete', async () => {
    const doc = await seedDoc({ externalId: 'idempotent-same' });
    await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    const before = await readStatus(doc.id);
    expect(before.semantic_index_status).toBe('complete');

    const second = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(second.idempotentSkip).toBe(true);
    expect(second.chunksCreated).toBe(0);
    expect(second.memoriesCreated).toBe(0);
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('complete');
    expect(after.indexed_content_hash).toBe(before.indexed_content_hash);
  });

  it('re-index from complete + different hash: replaces chunks atomically; status remains complete; last_error cleared', async () => {
    const doc = await seedDoc({ externalId: 'reindex-diff' });
    const first = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    const NEXT = 'Different content.\n\n' + 'token '.repeat(900);
    const second = await service.indexText({ userId: USER, documentId: doc.id, text: NEXT });
    expect(second.idempotentSkip).toBe(false);
    expect(second.chunksCreated).toBeGreaterThan(0);
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('complete');
    expect(after.indexed_content_hash).not.toBe(first.indexedContentHash);
    expect(after.last_error).toBeNull();
  });

  it('semantic validation: oversized text → IndexSemanticValidationError + durable failed + last_error.code=index_text_too_large', async () => {
    const doc = await seedDoc({ externalId: 'too-large' });
    const tooBig = 'x'.repeat(MAX_INDEX_TEXT_BYTES + 1);
    const err = await service
      .indexText({ userId: USER, documentId: doc.id, text: tooBig })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(IndexSemanticValidationError);
    expect((err as IndexSemanticValidationError).code).toBe('index_text_too_large');
    const after = await readStatus(doc.id);
    expect(after.semantic_index_status).toBe('failed');
    expect(after.last_error?.code).toBe('index_text_too_large');
    expect(after.last_error?.layer).toBe('semantic_index');
  });
});
