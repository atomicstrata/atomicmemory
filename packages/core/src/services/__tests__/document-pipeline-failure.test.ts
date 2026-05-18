/**
 * Phase F — cross-layer document-pipeline failure regressions.
 *
 * These tests walk the full register → uploadRaw → indexText
 * pipeline against a real Postgres + LocalFs store and prove the
 * audit's failure invariants from rev 18:
 *
 *   1. Indexer failure preserves the managed-blob bytes AND the
 *      durable `semantic_index_status='failed'` envelope.
 *   2. Retry of a previously-failed index succeeds and clears
 *      `last_error.semantic_index`. No duplicate active chunks.
 *   3. `store.put` failure marks `raw_storage_failed`. Retry with a
 *      healthy store completes and clears `last_error.raw_storage`
 *      (locked down by this commit's blob-repo fix).
 *   4. Register-only unsupported variant: row readable; no raw
 *      bytes, chunks, memories.
 *   5. Upload-pipeline unsupported variant: register unsupported +
 *      uploadRaw stores bytes; row stays unsupported / not_required;
 *      no chunks, memories.
 *
 * The embedding provider is mocked at the top of the file so the
 * indexer can be flipped between "throw" and "succeed" mid-test
 * without rebuilding the service. The store is a real `LocalFsRawContentStore`
 * rooted at a tmpdir; tests assert on the file system via
 * `store.head()`.
 *
 * Hits the same Postgres test DB (DATABASE_URL in `.env.test`) the
 * existing indexer + upload tests use; the embedding provider is
 * the only mocked surface.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const embedShouldThrow = vi.hoisted(() => ({ on: false }));
vi.mock('../embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../embedding.js')>();
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => {
      if (embedShouldThrow.on) {
        throw new Error('simulated embedTexts failure');
      }
      const { config: cfg } = await import('../../config.js');
      return texts.map(() => new Array(cfg.embeddingDimensions).fill(0));
    }),
  };
});

import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { DocumentService } from '../document-service.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import type { RegisterRawDocumentInput } from '../../db/raw-document-types.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'phase-f-pipeline-failure-test';
const PREFIX = 'phase-f';
let storageRoot: string;
let store: LocalFsRawContentStore;
let service: DocumentService;

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-phase-f-'));
  store = new LocalFsRawContentStore({ root: storageRoot });
  service = new DocumentService(pool, {
    rawContentStore: store,
    config: { rawStoragePrefix: PREFIX, rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
  });
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDocumentTables(pool);
  embedShouldThrow.on = false;
});

interface DocumentRowSnapshot {
  storage_mode: string;
  raw_storage_status: string;
  storage_uri: string | null;
  extraction_status: string;
  semantic_index_status: string;
  last_error: { layer: string; code: string } | null;
}

async function seedDoc(opts: {
  externalId: string;
  extractionStatus?: RegisterRawDocumentInput['extractionStatus'];
  semanticIndexStatus?: RegisterRawDocumentInput['semanticIndexStatus'];
}): Promise<{ id: string }> {
  const src = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'webapp-file', provider: 'manual-upload',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId: opts.externalId,
    extractionStatus: opts.extractionStatus ?? 'pending',
    semanticIndexStatus: opts.semanticIndexStatus ?? 'pending',
  });
  return { id: reg.document.id };
}

async function readRow(documentId: string): Promise<DocumentRowSnapshot> {
  const result = await pool.query<DocumentRowSnapshot>(
    `SELECT storage_mode, raw_storage_status, storage_uri,
            extraction_status, semantic_index_status, last_error
       FROM raw_documents WHERE id = $1`,
    [documentId],
  );
  return result.rows[0]!;
}

async function countActiveChunksAndMemories(documentId: string): Promise<{ chunks: number; memories: number }> {
  const c = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM document_chunks
      WHERE raw_document_id = $1 AND deleted_at IS NULL`,
    [documentId],
  );
  const m = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM memories
      WHERE raw_document_id = $1 AND deleted_at IS NULL`,
    [documentId],
  );
  return { chunks: c.rows[0]!.n, memories: m.rows[0]!.n };
}

/**
 * Convenience assertion: managed-blob bytes are present on disk
 * for the row's `storage_uri`, no active chunks, no active
 * memories. The "indexer-fail preserves blob" and "upload-pipeline
 * unsupported variant" tests share this exact post-state.
 */
async function expectBlobStoredWithNoIndexedChildren(
  row: DocumentRowSnapshot,
  documentId: string,
  bodyLength: number,
): Promise<void> {
  expect(row.storage_uri).not.toBeNull();
  const head = await store.head(row.storage_uri!);
  expect(head.exists).toBe(true);
  expect(head.metadata?.contentLength).toBe(bodyLength);
  const counts = await countActiveChunksAndMemories(documentId);
  expect(counts).toEqual({ chunks: 0, memories: 0 });
}

/**
 * Build a DocumentService whose `store.put` throws once and then
 * delegates to the real `LocalFsRawContentStore` on subsequent
 * calls. Used to drive the `raw_storage_failed → blob_stored`
 * retry path deterministically — the same service handle covers
 * both the failing first attempt and the recovered second attempt.
 */
function makeOneShotFailingUploadService(): DocumentService {
  let nextPutShouldFail = true;
  const flakyStore = {
    provider: store.provider,
    put: async (input: { key: string; body: Buffer; contentType?: string }) => {
      if (nextPutShouldFail) {
        nextPutShouldFail = false;
        throw new Error('simulated transient put failure');
      }
      return store.put(input);
    },
    get: store.get.bind(store),
    head: store.head.bind(store),
    delete: store.delete.bind(store),
  } as unknown as LocalFsRawContentStore;
  return new DocumentService(pool, {
    rawContentStore: flakyStore,
    config: { rawStoragePrefix: PREFIX, rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET },
  });
}

const SAMPLE_TEXT = 'Section header.\n\n' + 'word '.repeat(900);

describe('Phase F — register → uploadRaw → indexText pipeline failure', () => {
  it('indexer failure (embedTexts throws) preserves managed-blob bytes + lands semantic_index_status=failed; no chunks/memories', async () => {
    const doc = await seedDoc({ externalId: 'pipeline-index-fail' });
    const body = Buffer.from('phase-f-payload-1', 'utf8');
    const upload = await service.uploadRaw({ userId: USER, documentId: doc.id, body });
    expect(upload.rawStorageStatus).toBe('blob_stored');

    embedShouldThrow.on = true;
    await expect(
      service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE_TEXT }),
    ).rejects.toThrow(/simulated embedTexts failure/);

    const row = await readRow(doc.id);
    expect(row.storage_mode).toBe('managed_blob');
    expect(row.raw_storage_status).toBe('blob_stored');
    expect(row.semantic_index_status).toBe('failed');
    expect(row.last_error?.layer).toBe('semantic_index');
    expect(row.last_error?.code).toBe('unknown');

    await expectBlobStoredWithNoIndexedChildren(row, doc.id, body.length);
  });

  it('retry of a failed index succeeds, clears last_error.semantic_index, and produces no duplicate active chunks/memories', async () => {
    const doc = await seedDoc({ externalId: 'pipeline-index-retry' });
    const body = Buffer.from('phase-f-payload-retry', 'utf8');
    await service.uploadRaw({ userId: USER, documentId: doc.id, body });

    // First attempt fails durably.
    embedShouldThrow.on = true;
    await expect(
      service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE_TEXT }),
    ).rejects.toThrow();
    const failedRow = await readRow(doc.id);
    expect(failedRow.semantic_index_status).toBe('failed');
    expect(failedRow.last_error?.layer).toBe('semantic_index');

    // Retry with healthy embedder. The Phase B indexer accepts
    // `'failed'` as a permitted source state for retry.
    embedShouldThrow.on = false;
    const retry = await service.indexText({
      userId: USER, documentId: doc.id, text: SAMPLE_TEXT,
    });
    expect(retry.idempotentSkip).toBe(false);
    expect(retry.chunksCreated).toBeGreaterThan(0);
    expect(retry.memoriesCreated).toBe(retry.chunksCreated);

    const successRow = await readRow(doc.id);
    expect(successRow.semantic_index_status).toBe('complete');
    expect(successRow.last_error).toBeNull();

    // Idempotency: only the retry's chunks/memories are visible.
    const counts = await countActiveChunksAndMemories(doc.id);
    expect(counts.chunks).toBe(retry.chunksCreated);
    expect(counts.memories).toBe(retry.memoriesCreated);
  });

  it('store.put failure marks raw_storage_failed; retry with healthy store completes and clears last_error.raw_storage', async () => {
    // Phase F core fix locked down here: a successful managed-blob
    // promotion clears `last_error` ONLY when its layer was
    // `'raw_storage'`. Pre-fix this retry would have left the
    // failure envelope in place even though the row had recovered.
    const doc = await seedDoc({ externalId: 'pipeline-put-retry' });
    const body = Buffer.from('phase-f-payload-put-retry', 'utf8');
    const flakyService = makeOneShotFailingUploadService();
    await expect(
      flakyService.uploadRaw({ userId: USER, documentId: doc.id, body }),
    ).rejects.toThrow(/simulated transient put failure/);

    const failed = await readRow(doc.id);
    expect(failed.raw_storage_status).toBe('raw_storage_failed');
    expect(failed.last_error?.layer).toBe('raw_storage');
    expect(failed.last_error?.code).toBe('transport_error');

    // Retry through the same `flakyService` (now healthy).
    const retry = await flakyService.uploadRaw({
      userId: USER, documentId: doc.id, body,
    });
    expect(retry.rawStorageStatus).toBe('blob_stored');
    expect(retry.storageMode).toBe('managed_blob');

    const recovered = await readRow(doc.id);
    expect(recovered.raw_storage_status).toBe('blob_stored');
    expect(recovered.storage_mode).toBe('managed_blob');
    expect(recovered.last_error).toBeNull();

    // Blob actually exists on disk after the retry.
    const head = await store.head(retry.storageUri);
    expect(head.exists).toBe(true);
    expect(head.metadata?.contentLength).toBe(body.length);
  });

  it('successful uploadRaw does NOT clear an unrelated extraction `last_error`', async () => {
    // Layer-scoped clearing rule: a raw-storage success must
    // NOT clobber an existing extraction-layer envelope. Locks
    // the rule down so a future regression where the SET clause
    // drops the CASE doesn't silently erase failure context for
    // the OTHER layers.
    const doc = await seedDoc({ externalId: 'pipeline-cross-layer' });
    await pool.query(
      `UPDATE raw_documents
          SET last_error = $1::jsonb
        WHERE id = $2`,
      [
        JSON.stringify({
          layer: 'extraction',
          code: 'parser_threw',
          message: 'pre-existing extraction failure',
          occurred_at: '2026-05-09T00:00:00.000Z',
        }),
        doc.id,
      ],
    );
    const body = Buffer.from('phase-f-payload-cross-layer', 'utf8');
    await service.uploadRaw({ userId: USER, documentId: doc.id, body });

    const row = await readRow(doc.id);
    expect(row.raw_storage_status).toBe('blob_stored');
    // Extraction-layer envelope untouched.
    expect(row.last_error?.layer).toBe('extraction');
    expect(row.last_error?.code).toBe('parser_threw');
  });

  it('register-only unsupported variant: row readable; no chunks, memories, or managed-blob bytes', async () => {
    const doc = await seedDoc({
      externalId: 'pipeline-register-only-unsupported',
      extractionStatus: 'unsupported',
      semanticIndexStatus: 'not_required',
    });

    const row = await readRow(doc.id);
    expect(row.extraction_status).toBe('unsupported');
    expect(row.semantic_index_status).toBe('not_required');
    expect(row.raw_storage_status).toBe('pointer_recorded');
    expect(row.storage_mode).toBe('pointer_only');
    expect(row.storage_uri).toBeNull();
    expect(row.last_error).toBeNull();

    const counts = await countActiveChunksAndMemories(doc.id);
    expect(counts).toEqual({ chunks: 0, memories: 0 });
  });

  it('upload-pipeline unsupported variant: uploadRaw stores bytes; row keeps unsupported/not_required; no chunks/memories', async () => {
    const doc = await seedDoc({
      externalId: 'pipeline-upload-unsupported',
      extractionStatus: 'unsupported',
      semanticIndexStatus: 'not_required',
    });
    const body = Buffer.from('PAR1\x00\x00\x00\x00binary parquet payload', 'utf8');
    const upload = await service.uploadRaw({ userId: USER, documentId: doc.id, body });
    expect(upload.rawStorageStatus).toBe('blob_stored');
    expect(upload.storageMode).toBe('managed_blob');

    const row = await readRow(doc.id);
    expect(row.raw_storage_status).toBe('blob_stored');
    expect(row.storage_mode).toBe('managed_blob');
    // Layer statuses preserved through the raw upload.
    expect(row.extraction_status).toBe('unsupported');
    expect(row.semantic_index_status).toBe('not_required');
    expect(row.last_error).toBeNull();

    await expectBlobStoredWithNoIndexedChildren(row, doc.id, body.length);
  });
});
