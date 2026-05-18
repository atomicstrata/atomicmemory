/**
 * Integration tests for the Phase 2 document indexer.
 *
 * Covers: idempotency on byte-identical input, chunk + memory
 * provenance round-trip, re-index soft-deletes the prior generation,
 * and document delete cascades cleanly to chunks via the existing
 * delete paths. Hits a real Postgres test DB (DATABASE_URL in
 * .env.test); the embedding provider is mocked so the test process
 * never makes a network call.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../embedding.js')>();
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) => {
      const { config: cfg } = await import('../../config.js');
      return texts.map(() => new Array(cfg.embeddingDimensions).fill(0));
    }),
  };
});

import { pool } from '../../db/pool.js';
import { DocumentService } from '../document-service.js';
import { listActiveChunksForDocument } from '../../db/document-chunk-repository.js';
import { deleteBySource } from '../../db/repository-document-delete.js';
import { PHASE2_CHUNKER_VERSION } from '../document-chunker.js';
import {
  seedIndexableDoc,
  useDocumentIndexerLifecycle,
} from './document-indexer-test-helpers.js';

useDocumentIndexerLifecycle(pool);

const USER = 'doc-indexer-test-user';
const SAMPLE = 'Section header.\n\n' + 'word '.repeat(900);

async function seedDoc(sourceSite = 'drive', externalId = 'file-1') {
  return seedIndexableDoc(pool, USER, {
    externalId,
    sourceSite,
    provider: 'google-drive',
    externalUri: 'https://drive.google.com/file/d/abc',
  });
}

async function memoryProvenanceForDoc(documentId: string) {
  const result = await pool.query(
    `SELECT id, raw_document_id, document_chunk_id
       FROM memories
      WHERE raw_document_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [documentId],
  );
  return result.rows;
}

const service = new DocumentService(pool);

describe('document-indexer integration', () => {

  it('produces chunks + provenance-linked memories on first index', async () => {
    const doc = await seedDoc();
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.idempotentSkip).toBe(false);
    expect(result.chunksCreated).toBeGreaterThan(0);
    expect(result.memoriesCreated).toBe(result.chunksCreated);
    expect(result.chunkerVersion).toBe(PHASE2_CHUNKER_VERSION);

    const provs = await memoryProvenanceForDoc(doc.id);
    expect(provs).toHaveLength(result.chunksCreated);
    expect(provs.every((r) => r.raw_document_id === doc.id)).toBe(true);
    expect(provs.every((r) => r.document_chunk_id !== null)).toBe(true);
  });

  it('is idempotent on byte-identical re-index (no fresh chunks/memories)', async () => {
    const doc = await seedDoc();
    const first = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    const second = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(second.idempotentSkip).toBe(true);
    expect(second.chunksCreated).toBe(0);
    expect(second.memoriesCreated).toBe(0);
    expect(second.indexedContentHash).toBe(first.indexedContentHash);

    const memCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [doc.id],
    );
    expect(memCount.rows[0].n).toBe(first.memoriesCreated);
  });

  it('soft-deletes prior generation when text changes', async () => {
    const doc = await seedDoc();
    const first = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    const second = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE + ' EXTRA.' });
    expect(second.idempotentSkip).toBe(false);
    expect(second.indexedContentHash).not.toBe(first.indexedContentHash);

    const active = await listActiveChunksForDocument(pool, doc.id);
    expect(active).toHaveLength(second.chunksCreated);
    const tombstoned = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM document_chunks WHERE raw_document_id = $1 AND deleted_at IS NOT NULL`,
      [doc.id],
    );
    expect(tombstoned.rows[0].n).toBe(first.chunksCreated);
  });

  it('throws DocumentNotFoundError for an unknown document', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    await expect(service.indexText({ userId: USER, documentId: fakeId, text: 'hello' })).rejects.toThrow(/not found/);
  });

  it('throws IndexInputError for whitespace-only text (defensive in-process gate)', async () => {
    const doc = await seedDoc('drive', 'ws-1');
    await expect(
      service.indexText({ userId: USER, documentId: doc.id, text: '   \n\t  ' }),
    ).rejects.toThrow(/non-whitespace/);
  });

  it('threads document display metadata onto every derived memory (Phase 4)', async () => {
    // Register with display metadata so the indexer can copy it.
    const doc = await seedIndexableDoc(pool, USER, {
      externalId: 'metadata-1',
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
      displayName: 'report.pdf',
      mimeType: 'application/pdf',
      metadata: { uploadedBy: 'unit-test' },
    });

    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.chunksCreated).toBeGreaterThan(0);

    const rows = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [doc.id],
    );
    expect(rows.rows.length).toBe(result.memoriesCreated);
    for (const row of rows.rows) {
      expect(row.metadata.filename).toBe('report.pdf');
      expect(row.metadata.mimeType).toBe('application/pdf');
      expect(row.metadata.type).toBe('user-context');
      expect(row.metadata.uploadedBy).toBe('unit-test');
      expect(row.metadata.raw_document_id).toBe(doc.id);
    }
  });

  it('stamps each chunk-derived memory with its own document_chunk_id in metadata', async () => {
    const doc = await seedIndexableDoc(pool, USER, {
      externalId: 'metadata-chunk-id',
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
      displayName: 'multi.txt',
      mimeType: 'text/plain',
    });
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.chunksCreated).toBeGreaterThan(1);

    const rows = await pool.query<{ id: string; document_chunk_id: string; metadata: Record<string, unknown> }>(
      `SELECT id, document_chunk_id, metadata FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
      [doc.id],
    );
    const seen = new Set<string>();
    for (const row of rows.rows) {
      // Typed column and metadata field agree per row.
      expect(row.metadata.document_chunk_id).toBe(row.document_chunk_id);
      // Each chunk's id is unique.
      expect(seen.has(row.metadata.document_chunk_id as string)).toBe(false);
      seen.add(row.metadata.document_chunk_id as string);
      // Document-level fields stay constant across chunks.
      expect(row.metadata.raw_document_id).toBe(doc.id);
      expect(row.metadata.filename).toBe('multi.txt');
    }
  });

  it('first-class display columns win over raw_documents.metadata on key conflict', async () => {
    const doc = await seedIndexableDoc(pool, USER, {
      externalId: 'metadata-conflict',
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
      displayName: 'real.pdf',
      mimeType: 'application/pdf',
      metadata: { filename: 'spoofed.docx', mimeType: 'application/octet-stream' },
    });

    await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    const row = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [doc.id],
    );
    expect(row.rows[0].metadata.filename).toBe('real.pdf');
    expect(row.rows[0].metadata.mimeType).toBe('application/pdf');
  });

  it('does not overwrite the upstream content_hash when indexing', async () => {
    const upstreamHash = 'sha256:upstream-original';
    const doc = await seedIndexableDoc(pool, USER, {
      externalId: 'with-hash',
      contentHash: upstreamHash,
    });

    await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });

    const refetched = await pool.query<{ content_hash: string; indexed_content_hash: string | null }>(
      `SELECT content_hash, indexed_content_hash FROM raw_documents WHERE id = $1`,
      [doc.id],
    );
    expect(refetched.rows[0].content_hash).toBe(upstreamHash);
    expect(refetched.rows[0].indexed_content_hash).not.toBeNull();
    expect(refetched.rows[0].indexed_content_hash).not.toBe(upstreamHash);
  });

  it('two concurrent same-text index calls do not duplicate chunks/memories', async () => {
    const doc = await seedDoc();
    const [a, b] = await Promise.all([
      service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE }),
      service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE }),
    ]);
    expect(a.indexedContentHash).toBe(b.indexedContentHash);
    // Exactly one of them did the work; the other was an idempotent skip.
    expect(a.idempotentSkip || b.idempotentSkip).toBe(true);
    expect(a.idempotentSkip && b.idempotentSkip).toBe(false);

    const active = await listActiveChunksForDocument(pool, doc.id);
    const expected = a.idempotentSkip ? b.chunksCreated : a.chunksCreated;
    expect(active).toHaveLength(expected);
    const memoryCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [doc.id],
    );
    expect(memoryCount.rows[0].n).toBe(expected);
  });

  it('direct document delete cascades to chunks + provenance memories', async () => {
    const doc = await seedDoc('drive', 'cascade-1');
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.chunksCreated).toBeGreaterThan(0);

    const del = await service.delete(USER, doc.id);
    expect(del.alreadyDeleted).toBe(false);

    const active = await listActiveChunksForDocument(pool, doc.id);
    expect(active).toHaveLength(0);
    const memCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [doc.id],
    );
    expect(memCount.rows[0].n).toBe(0);

    // Idempotent on a second delete call (alreadyDeleted=true).
    const second = await service.delete(USER, doc.id);
    expect(second.alreadyDeleted).toBe(true);
  });

  it('cascade delete with the wrong user leaves the victim user\'s chunks + memories intact', async () => {
    const doc = await seedDoc('drive', 'cross-user-1');
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.chunksCreated).toBeGreaterThan(0);

    const cross = await service.delete('other-user', doc.id);
    expect(cross.alreadyDeleted).toBe(true);

    const active = await listActiveChunksForDocument(pool, doc.id);
    expect(active).toHaveLength(result.chunksCreated);
    const memCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM memories WHERE raw_document_id = $1 AND deleted_at IS NULL`,
      [doc.id],
    );
    expect(memCount.rows[0].n).toBe(result.memoriesCreated);
    expect((await service.get(USER, doc.id))?.id).toBe(doc.id);
  });

  it('source-reset cascades to chunk soft-delete in the same transaction', async () => {
    const doc = await seedDoc('drive', 'file-1');
    const result = await service.indexText({ userId: USER, documentId: doc.id, text: SAMPLE });
    expect(result.chunksCreated).toBeGreaterThan(0);

    await deleteBySource(pool, USER, 'drive');
    const active = await listActiveChunksForDocument(pool, doc.id);
    expect(active).toHaveLength(0);
  });
});
