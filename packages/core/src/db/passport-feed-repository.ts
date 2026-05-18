/**
 * Phase D — passport feed grouped data-layer query.
 *
 * Returns one row per documentId-with-memories (via `GROUP BY
 * raw_document_id`) plus 1:1 standalone-memory rows (memories whose
 * `raw_document_id IS NULL`), ordered by a unified
 * `(sort_at DESC, sort_id DESC)` cursor.
 *
 * The webapp's `/api/context/passport` route consumes this as the
 * memory-feed stream of its server-side two-stream merge — no
 * webapp-side dedupe, no possibility of a single document spanning
 * pages, no chunk-budget heuristic. A document with N memories
 * appears EXACTLY once on the page that contains its latest
 * chunk.
 *
 * Internal columns (embeddings, audit fields, internal metadata) are
 * NEVER returned by this repository — the SELECT enumerates only the
 * public projection that the route formatter then ships on the wire.
 *
 * Standard `+1 over-fetch` pagination: the route slices the extra
 * row off and encodes its `(sort_at, sort_id)` as `next_cursor`.
 */

import type pg from 'pg';
import {
  encodeListCursor,
  type DocumentListCursor,
} from './document-list-cursor.js';

export interface PassportFeedDocumentGroupedRow {
  kind: 'document_grouped';
  documentId: string;
  sortAt: Date;
  sortId: string;
  representative: {
    id: string;
    content: string;
    createdAt: Date;
    sourceSite: string | null;
  };
  chunkCount: number;
  rawStorageStatus: string;
  extractionStatus: string;
  semanticIndexStatus: string;
  lastError: unknown;
  displayName: string | null;
  mimeType: string | null;
  /**
   * Phase 7a wire widening (rev-2 §2): grouped rows carry the
   * document's `storage_provider` + INTERNAL `raw_storage_metadata`
   * blob. The route formatter projects them through
   * `formatPublicRawStorageMetadata` + `getDeleteSemantics` before
   * emitting to the wire — internal `upload_result`, AES-GCM
   * `nonce`/`tag`/`key_id`, etc. are stripped at the formatter
   * boundary.
   */
  storageProvider: string | null;
  rawStorageMetadata: Record<string, unknown>;
}

export interface PassportFeedStandaloneMemoryRow {
  kind: 'standalone_memory';
  sortAt: Date;
  sortId: string;
  memory: {
    id: string;
    content: string;
    createdAt: Date;
    sourceSite: string | null;
  };
}

export type PassportFeedRow =
  | PassportFeedDocumentGroupedRow
  | PassportFeedStandaloneMemoryRow;

export interface ListPassportFeedInput {
  userId: string;
  limit: number;
  cursor: DocumentListCursor | null;
}

export interface ListPassportFeedResult {
  rows: PassportFeedRow[];
  nextCursor: string | null;
}

const PASSPORT_FEED_DEFAULT_LIMIT = 50;
const PASSPORT_FEED_MAX_LIMIT = 100;

/**
 * Phase D — main passport-feed query. Single SQL statement; one
 * UNION ALL across:
 *   (A) one row per documentId with at least one non-deleted memory.
 *       Grouped via `GROUP BY raw_document_id`; the latest chunk in
 *       each group is the representative (`(created_at DESC, id DESC)`
 *       picks it via `ARRAY_AGG(...)`)[1]). Joined to
 *       `raw_documents` for the Phase B status envelope; the join
 *       also enforces `deleted_at IS NULL` + `user_id` match so
 *       cross-user / soft-deleted documents fall out.
 *   (B) one row per non-deleted memory whose `raw_document_id IS NULL`.
 * Sort by `(sort_at DESC, sort_id DESC)` over the unioned rows; the
 * route then slices the `+1` over-fetch and encodes the last consumed
 * row's tuple as `next_cursor`.
 */
export async function listPassportFeed(
  pool: pg.Pool,
  input: ListPassportFeedInput,
): Promise<ListPassportFeedResult> {
  const limit = clampLimit(input.limit);
  const overFetch = limit + 1;
  const params: unknown[] = [input.userId, overFetch];
  const cursorClauseGrouped = buildCursorClause(input.cursor, params, 'grouped');
  const cursorClauseStandalone = buildCursorClause(input.cursor, params, 'standalone');

  const sql = `
    WITH memory_groups AS (
      SELECT m.raw_document_id AS document_id,
             MAX(m.created_at) AS sort_at,
             (ARRAY_AGG(m.id          ORDER BY m.created_at DESC, m.id DESC))[1] AS sort_id,
             (ARRAY_AGG(m.id          ORDER BY m.created_at DESC, m.id DESC))[1] AS rep_id,
             (ARRAY_AGG(m.content     ORDER BY m.created_at DESC, m.id DESC))[1] AS rep_content,
             (ARRAY_AGG(m.created_at  ORDER BY m.created_at DESC, m.id DESC))[1] AS rep_created_at,
             (ARRAY_AGG(m.source_site ORDER BY m.created_at DESC, m.id DESC))[1] AS rep_source_site,
             COUNT(*)::INT AS chunk_count
        FROM memories m
       WHERE m.user_id = $1
         AND m.deleted_at IS NULL
         AND m.raw_document_id IS NOT NULL
       GROUP BY m.raw_document_id
    )
    SELECT 'document_grouped'::text AS kind,
           mg.document_id::text     AS document_id,
           mg.sort_at, mg.sort_id::text AS sort_id,
           mg.rep_id::text          AS rep_id,
           mg.rep_content, mg.rep_created_at, mg.rep_source_site,
           mg.chunk_count,
           rd.raw_storage_status, rd.extraction_status, rd.semantic_index_status,
           rd.last_error, rd.display_name, rd.mime_type,
           rd.storage_provider, rd.raw_storage_metadata
      FROM memory_groups mg
      JOIN raw_documents rd
        ON rd.id = mg.document_id
       AND rd.user_id = $1
       AND rd.deleted_at IS NULL
     WHERE ${cursorClauseGrouped}
    UNION ALL
    SELECT 'standalone_memory'::text AS kind,
           NULL                       AS document_id,
           m.created_at               AS sort_at,
           m.id::text                 AS sort_id,
           m.id::text                 AS rep_id,
           m.content                  AS rep_content,
           m.created_at               AS rep_created_at,
           m.source_site              AS rep_source_site,
           1                          AS chunk_count,
           NULL::text                 AS raw_storage_status,
           NULL::text                 AS extraction_status,
           NULL::text                 AS semantic_index_status,
           NULL::jsonb                AS last_error,
           NULL::text                 AS display_name,
           NULL::text                 AS mime_type,
           NULL::text                 AS storage_provider,
           NULL::jsonb                AS raw_storage_metadata
      FROM memories m
     WHERE m.user_id = $1
       AND m.deleted_at IS NULL
       AND m.raw_document_id IS NULL
       AND ${cursorClauseStandalone}
    ORDER BY sort_at DESC, sort_id DESC
    LIMIT $2
  `;
  const result = await pool.query(sql, params);
  const all = result.rows.map(toPassportFeedRow);
  return slicePageWithCursor(all, limit);
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return PASSPORT_FEED_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PASSPORT_FEED_MAX_LIMIT, Math.floor(raw)));
}

/**
 * Build the cursor predicate fragment for one branch of the UNION.
 * Returns a SQL boolean expression that evaluates to TRUE when the
 * caller did not supply a cursor (first page) or when the row's
 * `(sort_at, sort_id)` is strictly less than the supplied cursor.
 *
 * Each branch references different columns (`mg.sort_at` for the
 * grouped CTE; `m.created_at` for standalone memories), so we
 * assemble the fragment per-branch and append fresh parameter
 * placeholders to `params` for each branch's bind sites.
 */
function buildCursorClause(
  cursor: DocumentListCursor | null,
  params: unknown[],
  branch: 'grouped' | 'standalone',
): string {
  if (cursor === null) return 'TRUE';
  params.push(cursor.sortAt, cursor.sortId);
  const atIdx = params.length - 1;
  const idIdx = params.length;
  if (branch === 'grouped') {
    return `(mg.sort_at, mg.sort_id::text) < ($${atIdx}::timestamptz, $${idIdx}::text)`;
  }
  return `(m.created_at, m.id::text) < ($${atIdx}::timestamptz, $${idIdx}::text)`;
}

/** Map one Postgres row to the kind-discriminated public shape. */
function toPassportFeedRow(row: Record<string, unknown>): PassportFeedRow {
  const kind = row.kind as 'document_grouped' | 'standalone_memory';
  if (kind === 'document_grouped') {
    return toDocumentGroupedRow(row);
  }
  return toStandaloneMemoryRow(row);
}

function toDocumentGroupedRow(row: Record<string, unknown>): PassportFeedDocumentGroupedRow {
  return {
    kind: 'document_grouped',
    documentId: row.document_id as string,
    sortAt: row.sort_at as Date,
    sortId: row.sort_id as string,
    representative: {
      id: row.rep_id as string,
      content: row.rep_content as string,
      createdAt: row.rep_created_at as Date,
      sourceSite: (row.rep_source_site as string | null) ?? null,
    },
    chunkCount: Number(row.chunk_count),
    rawStorageStatus: row.raw_storage_status as string,
    extractionStatus: row.extraction_status as string,
    semanticIndexStatus: row.semantic_index_status as string,
    lastError: row.last_error,
    displayName: (row.display_name as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    storageProvider: (row.storage_provider as string | null) ?? null,
    rawStorageMetadata: (row.raw_storage_metadata as Record<string, unknown> | null) ?? {},
  };
}

function toStandaloneMemoryRow(row: Record<string, unknown>): PassportFeedStandaloneMemoryRow {
  return {
    kind: 'standalone_memory',
    sortAt: row.sort_at as Date,
    sortId: row.sort_id as string,
    memory: {
      id: row.rep_id as string,
      content: row.rep_content as string,
      createdAt: row.rep_created_at as Date,
      sourceSite: (row.rep_source_site as string | null) ?? null,
    },
  };
}

/**
 * Cursor-aware page slicer. The repository over-fetches by one row;
 * if we got the full `limit + 1`, the last consumed row's
 * `(sort_at, sort_id)` becomes the next cursor. Otherwise the page
 * exhausts the stream and `nextCursor === null`.
 */
function slicePageWithCursor(
  candidates: PassportFeedRow[],
  limit: number,
): ListPassportFeedResult {
  if (candidates.length <= limit) {
    return { rows: candidates, nextCursor: null };
  }
  const rows = candidates.slice(0, limit);
  const last = rows[rows.length - 1]!;
  const sortAt = last.sortAt instanceof Date
    ? last.sortAt.toISOString()
    : String(last.sortAt);
  return {
    rows,
    nextCursor: encodeListCursor({ sortAt, sortId: last.sortId }),
  };
}
