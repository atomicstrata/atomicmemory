/**
 * Postgres queries for document_chunks (Phase 2).
 *
 * Function-style module mirroring `raw-document-repository.ts`. The
 * `*WithClient` deletion variant exists so `deleteBySource` can include
 * chunk soft-deletion inside its single transaction, and the batch
 * insert uses a multi-row INSERT (one round-trip per index call) so
 * indexing a 50-chunk document is ~50× cheaper than per-row inserts.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import type {
  DocumentChunkRow,
  InsertDocumentChunkInput,
} from './document-chunk-types.js';

/**
 * Either a top-level `pg.Pool` (auto-checks-out a client per query) or a
 * checked-out `pg.PoolClient` (used to keep a sequence of statements on
 * the same DB connection — e.g., inside a BEGIN/COMMIT). Phase 2's
 * indexer threads a `PoolClient` through every chunk-write helper so the
 * idempotency check + chunk + memory mutations live in one transaction.
 */
type Querier = pg.Pool | pg.PoolClient;

const DOCUMENT_CHUNK_COLUMNS =
  'id, user_id, raw_document_id, chunk_index, content, content_hash, char_start, char_end, token_count, embedding, parser_version, chunker_version, metadata, created_at, deleted_at';

const INSERT_COLUMNS =
  'user_id, raw_document_id, chunk_index, content, content_hash, char_start, char_end, token_count, embedding, parser_version, chunker_version, metadata';

// ---------------------------------------------------------------------------
// Insert (batch)
// ---------------------------------------------------------------------------

/**
 * Insert a batch of chunks for one document. Single round-trip; the
 * caller is expected to have already verified the active-unique slot
 * is free (the indexer's idempotency check covers this).
 */
export async function insertDocumentChunks(
  q: Querier,
  inputs: InsertDocumentChunkInput[],
): Promise<DocumentChunkRow[]> {
  if (inputs.length === 0) return [];
  const { sql, params } = buildBatchInsertSql(inputs);
  const result = await q.query(sql, params);
  return result.rows.map(rowToDocumentChunk);
}

interface BatchInsertSql {
  sql: string;
  params: unknown[];
}

function buildBatchInsertSql(inputs: InsertDocumentChunkInput[]): BatchInsertSql {
  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const input of inputs) {
    placeholders.push(buildOneRowPlaceholders(params.length));
    pushOneRowParams(params, input);
  }
  const sql = `INSERT INTO document_chunks (${INSERT_COLUMNS}) VALUES ${placeholders.join(', ')} RETURNING ${DOCUMENT_CHUNK_COLUMNS}`;
  return { sql, params };
}

function buildOneRowPlaceholders(start: number): string {
  const slots: string[] = [];
  for (let i = 0; i < 12; i++) slots.push(`$${start + i + 1}`);
  // metadata is the 12th column — cast as jsonb on the wire.
  slots[11] = `${slots[11]}::jsonb`;
  return `(${slots.join(', ')})`;
}

function pushOneRowParams(params: unknown[], input: InsertDocumentChunkInput): void {
  params.push(
    input.userId,
    input.rawDocumentId,
    input.chunkIndex,
    input.content,
    input.contentHash,
    input.charStart,
    input.charEnd,
    input.tokenCount,
    pgvector.toSql(input.embedding),
    input.parserVersion,
    input.chunkerVersion,
    JSON.stringify(input.metadata ?? {}),
  );
}

// ---------------------------------------------------------------------------
// List / lookup
// ---------------------------------------------------------------------------

/**
 * Active chunks for a document, ordered by chunk_index. Optionally
 * filtered to a single chunker_version (the indexer needs that to
 * decide whether re-index is required vs idempotent skip).
 */
export async function listActiveChunksForDocument(
  q: Querier,
  rawDocumentId: string,
  options: { chunkerVersion?: string } = {},
): Promise<DocumentChunkRow[]> {
  const params: unknown[] = [rawDocumentId];
  let where = 'raw_document_id = $1 AND deleted_at IS NULL';
  if (options.chunkerVersion) {
    params.push(options.chunkerVersion);
    where += ' AND chunker_version = $2';
  }
  const result = await q.query(
    `SELECT ${DOCUMENT_CHUNK_COLUMNS}
       FROM document_chunks
      WHERE ${where}
      ORDER BY chunk_index ASC`,
    params,
  );
  return result.rows.map(rowToDocumentChunk);
}

export async function countActiveChunksForDocument(
  q: Querier,
  rawDocumentId: string,
  chunkerVersion: string,
): Promise<number> {
  const result = await q.query(
    `SELECT COUNT(*)::int AS n
       FROM document_chunks
      WHERE raw_document_id = $1 AND chunker_version = $2 AND deleted_at IS NULL`,
    [rawDocumentId, chunkerVersion],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Soft-delete + cascading deletion paths
// ---------------------------------------------------------------------------

/**
 * Soft-delete every active chunk for a document. Used by the indexer
 * when the input text changes (re-chunk path) and by the document
 * delete route when the document is tombstoned.
 */
export async function softDeleteChunksForDocument(
  q: Querier,
  userId: string,
  rawDocumentId: string,
): Promise<number> {
  const result = await q.query(
    `UPDATE document_chunks
        SET deleted_at = NOW()
      WHERE user_id = $1 AND raw_document_id = $2 AND deleted_at IS NULL`,
    [userId, rawDocumentId],
  );
  return result.rowCount ?? 0;
}

/**
 * Soft-delete every active chunk whose document belongs to the
 * (user, source_site) pair. Used inside the existing
 * `deleteBySource` transaction so source-reset stays one atomic
 * operation across memories, episodes, documents, and chunks.
 */
export async function deleteChunksBySourceWithClient(
  client: pg.PoolClient,
  userId: string,
  sourceSite: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE document_chunks c
        SET deleted_at = NOW()
       FROM raw_documents d
       JOIN raw_sources s ON s.id = d.raw_source_id
      WHERE c.raw_document_id = d.id
        AND c.user_id = $1
        AND s.source_site = $2
        AND c.deleted_at IS NULL`,
    [userId, sourceSite],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToDocumentChunk(row: Record<string, unknown>): DocumentChunkRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    rawDocumentId: row.raw_document_id as string,
    chunkIndex: row.chunk_index as number,
    content: row.content as string,
    contentHash: row.content_hash as string,
    charStart: row.char_start as number,
    charEnd: row.char_end as number,
    tokenCount: row.token_count as number,
    embedding: parseEmbedding(row.embedding),
    parserVersion: row.parser_version as string,
    chunkerVersion: row.chunker_version as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at as Date,
    deletedAt: (row.deleted_at as Date | null) ?? null,
  };
}

/**
 * pgvector returns the column either as a string like `"[0.1,0.2,...]"`
 * (default text protocol) or as an already-parsed array (when a custom
 * type parser is registered). Handle both — the cast is cheap and
 * avoids depending on a global type-parser registration here.
 */
function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => Number(s));
  }
  return [];
}
