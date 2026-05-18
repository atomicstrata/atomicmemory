/**
 * Row + input types for the document_chunks table (Phase 2).
 *
 * Mirrors the columns in `schema.sql`. The `embedding` field stays on
 * the row (vs being held only in `memories.embedding`) so the chunk
 * store supports raw chunk-level lookups for re-index and audit
 * without round-tripping through the memory layer.
 */

/**
 * Fields shared by the persisted row and the insert input. Extracted
 * so the two shapes don't drift independently.
 */
interface DocumentChunkBody {
  userId: string;
  rawDocumentId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
  embedding: number[];
  parserVersion: string;
  chunkerVersion: string;
}

export interface DocumentChunkRow extends DocumentChunkBody {
  id: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface InsertDocumentChunkInput extends DocumentChunkBody {
  metadata?: Record<string, unknown>;
}
