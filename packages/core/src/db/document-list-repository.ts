/**
 * Phase D — focused module for the cursor-paginated user-scoped
 * document list helpers (`GET /v1/documents`,
 * `GET /v1/documents/without-memories`).
 *
 * Split out from `raw-document-repository.ts` to keep that file
 * under the 400 non-comment LOC workspace rule. The legacy
 * offset/limit + source_site `listRawDocuments` helper still lives
 * in `raw-document-repository.ts`; only the Phase D cursor-based
 * surfaces are here.
 *
 * Imports `RAW_DOCUMENT_COLUMNS` + `rowToRawDocument` from the
 * sibling repo so the canonical column set + projection stays in
 * one place.
 */

import type pg from 'pg';
import {
  encodeListCursor,
  type DocumentListCursor,
} from './document-list-cursor.js';
import {
  RAW_DOCUMENT_COLUMNS,
  rowToRawDocument,
} from './raw-document-repository.js';
import type { RawDocumentRow } from './raw-document-types.js';

/**
 * Phase D — coarse status-bucket filter for the standalone
 * `GET /v1/documents` list endpoint. The buckets pivot on the new
 * Phase B per-layer status columns; `'all'` returns every active
 * row. The recovery-relevant buckets serve the UI's
 * "what is broken / what needs attention" surfaces; the
 * `'unsupported'` bucket lights up `.parquet` and similar
 * stored-but-not-indexed files.
 */
export type DocumentListStatusFilter = 'failed' | 'unsupported' | 'pending' | 'all';

export interface ListDocumentsForUserInput {
  userId: string;
  limit?: number;
  cursor?: DocumentListCursor | null;
  statusFilter?: DocumentListStatusFilter;
}

export interface ListDocumentsForUserResult {
  documents: RawDocumentRow[];
  nextCursor: string | null;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

/**
 * Phase D — cursor-paginated user-scoped document list with optional
 * recovery-status bucket filter. Distinct from `listRawDocuments`
 * (offset/limit + source_site filter) which backs the legacy
 * `GET /v1/documents/list` route.
 *
 * Cursor semantics: stable ordering on `(created_at DESC, id DESC)`.
 * Standard `+1 over-fetch` pattern; `nextCursor` only when more
 * rows exist beyond the current page.
 *
 * Status filter expressions:
 *   - 'failed' — any layer is failed (extraction OR semantic_index OR
 *     raw_storage)
 *   - 'unsupported' — extraction_status = 'unsupported' (the
 *     deliberately-not-indexed bucket)
 *   - 'pending' — extraction or semantic_index is pending/running.
 *     Forward-compatible with the future async-worker PR; in this
 *     PR's synchronous flow `running` matches only manually seeded
 *     rows (the Phase B indexer never commits 'running').
 *   - 'all' — no status filter.
 */
export async function listDocumentsForUser(
  pool: pg.Pool,
  input: ListDocumentsForUserInput,
): Promise<ListDocumentsForUserResult> {
  const limit = clampListLimit(input.limit);
  const overFetch = limit + 1;
  const params: unknown[] = [input.userId, overFetch];
  const wheres: string[] = ['user_id = $1', 'deleted_at IS NULL'];

  const statusClause = buildStatusFilterSql(input.statusFilter ?? 'all', params);
  if (statusClause !== null) wheres.push(statusClause);

  if (input.cursor) {
    params.push(input.cursor.sortAt, input.cursor.sortId);
    wheres.push(
      `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  const sql = `SELECT ${RAW_DOCUMENT_COLUMNS}
                 FROM raw_documents
                WHERE ${wheres.join(' AND ')}
                ORDER BY created_at DESC, id DESC
                LIMIT $2`;
  const result = await pool.query(sql, params);
  return slicePageWithCursor(result.rows.map(rowToRawDocument), limit);
}

function clampListLimit(raw: number | undefined): number {
  if (raw === undefined) return LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(raw)) return LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(raw)));
}

/**
 * Append the parameterised SQL that narrows the document list to one
 * recovery-status bucket. Returns the WHERE fragment (without leading
 * AND), or null when the filter is `'all'`.
 *
 * Mutates `params` to push the literal status values; this keeps each
 * value explicitly bound rather than embedded in the SQL string, so
 * the query is fully prepared-statement friendly.
 *
 * Lifecycle awareness (Filecoin refactor):
 *   - `failed` matches `extraction_status='failed'` OR
 *     `semantic_index_status='failed'` OR `raw_storage_status` in
 *     `{raw_storage_failed, blob_archival_failed}`. The two raw-storage
 *     failure terminals are equivalent surfaces for "the bytes never
 *     made it" — immediate-provider catch path vs Phase 3
 *     reconciler's permanent-failure terminal — and both belong in
 *     the same recovery bucket.
 *   - `pending` matches extraction/semantic_index pending/running OR
 *     `raw_storage_status='blob_pending'`. The eventual-provider
 *     in-flight state belongs in the pending bucket alongside the
 *     extraction/index pending/running rows.
 *   - `unsupported` is raw-storage-agnostic.
 */
function buildStatusFilterSql(
  filter: DocumentListStatusFilter,
  params: unknown[],
): string | null {
  if (filter === 'all') return null;
  if (filter === 'failed') {
    params.push('failed', 'failed', 'raw_storage_failed', 'blob_archival_failed');
    return `(extraction_status = $${params.length - 3}
            OR semantic_index_status = $${params.length - 2}
            OR raw_storage_status IN ($${params.length - 1}, $${params.length}))`;
  }
  if (filter === 'unsupported') {
    params.push('unsupported');
    return `extraction_status = $${params.length}`;
  }
  // 'pending' — extraction OR semantic_index OR raw_storage is in a
  // pre-completion state. `running` is included for forward
  // compatibility with the future async-worker PR; `blob_pending`
  // is the Filecoin/eventual-provider in-flight state.
  params.push('pending', 'running', 'pending', 'running', 'blob_pending');
  return `(extraction_status IN ($${params.length - 4}, $${params.length - 3})
          OR semantic_index_status IN ($${params.length - 2}, $${params.length - 1})
          OR raw_storage_status = $${params.length})`;
}

/**
 * Cursor-aware page slicer. The repository over-fetches by one row;
 * if we got the full `limit + 1`, the last consumed row's
 * `(created_at, id)` becomes the next cursor. Otherwise the page
 * exhausts the stream and `nextCursor === null`.
 */
function slicePageWithCursor(
  candidates: RawDocumentRow[],
  limit: number,
): ListDocumentsForUserResult {
  if (candidates.length <= limit) {
    return { documents: candidates, nextCursor: null };
  }
  const documents = candidates.slice(0, limit);
  const last = documents[documents.length - 1]!;
  const sortAt = last.createdAt instanceof Date
    ? last.createdAt.toISOString()
    : String(last.createdAt);
  return {
    documents,
    nextCursor: encodeListCursor({ sortAt, sortId: last.id }),
  };
}

/**
 * Phase D — layer-aware recovery filter consumed by
 * {@link listDocumentsWithoutMemoriesForUser}. Each layer's array (when
 * supplied) narrows that layer to one of the values; rows match when
 * ANY layer's value is in its array. An empty array on a layer means
 * "do not match this layer at all" (deliberate — the layer can be
 * scoped out by passing `[]` rather than omitting the key).
 */
export interface DocumentRecoveryStatusFilter {
  extraction?: Array<'pending' | 'running' | 'failed' | 'unsupported'>;
  semantic_index?: Array<'pending' | 'running' | 'failed' | 'stale'>;
  /**
   * Filecoin lifecycle refactor (Slice 2): includes `blob_pending`
   * (eventual provider still propagating) and `blob_archival_failed`
   * (Phase 3 reconciler's permanent-failure terminal) so a row stuck
   * in either state surfaces to `/without-memories`. `blob_available`
   * and `blob_tombstoned` are terminal-OK / no-longer-managed and
   * deliberately NOT recovery targets.
   */
  raw_storage?: Array<
    | 'raw_storage_failed'
    | 'pointer_recorded'
    | 'blob_pending'
    | 'blob_archival_failed'
  >;
}

export interface ListDocumentsWithoutMemoriesInput {
  userId: string;
  limit?: number;
  cursor?: DocumentListCursor | null;
  statusFilter?: DocumentRecoveryStatusFilter;
}

const DEFAULT_RECOVERY_STATUS_FILTER: Required<DocumentRecoveryStatusFilter> = {
  extraction: ['pending', 'failed', 'unsupported'],
  semantic_index: ['pending', 'failed'],
  // `blob_pending` and `blob_archival_failed` join the default so a
  // freshly-uploaded eventual-provider doc surfaces in the recovery
  // feed until the Phase 3 reconciler promotes it (or marks it
  // failed). `raw_storage_failed` stays for the existing upload-
  // failure path. `pointer_recorded` is NOT in the default — its
  // mere presence isn't a recovery signal — but the schema allows
  // callers to request it explicitly.
  raw_storage: ['raw_storage_failed', 'blob_pending', 'blob_archival_failed'],
};

/**
 * Phase D — list active documents with ZERO non-deleted memories AND
 * matching the layer-aware recovery filter. Backs
 * `GET /v1/documents/without-memories` and the document-only stream
 * of the passport server-side merge.
 *
 * Visibility: a row appears when it is the user's, not soft-deleted,
 * has no memories pointing to it (strict `NOT EXISTS` over
 * `memories.raw_document_id`), and at least one layer status sits in
 * its filter array. Default filter is recovery-relevant — failed,
 * pending, or unsupported across the three layers — so happy-path
 * pointer-only documents that simply have no chunks (e.g., future
 * Drive listings) do NOT surface in the passport synthetic-row
 * stream.
 */
export async function listDocumentsWithoutMemoriesForUser(
  pool: pg.Pool,
  input: ListDocumentsWithoutMemoriesInput,
): Promise<ListDocumentsForUserResult> {
  const limit = clampListLimit(input.limit);
  const overFetch = limit + 1;
  const filter = mergeRecoveryFilter(input.statusFilter);
  const params: unknown[] = [
    input.userId,
    overFetch,
    filter.extraction,
    filter.semantic_index,
    filter.raw_storage,
  ];
  const wheres: string[] = [
    'rd.user_id = $1',
    'rd.deleted_at IS NULL',
    'NOT EXISTS (SELECT 1 FROM memories m WHERE m.raw_document_id = rd.id AND m.deleted_at IS NULL)',
    `(rd.extraction_status     = ANY($3::text[])
     OR rd.semantic_index_status = ANY($4::text[])
     OR rd.raw_storage_status    = ANY($5::text[]))`,
  ];
  if (input.cursor) {
    params.push(input.cursor.sortAt, input.cursor.sortId);
    wheres.push(
      `(rd.created_at, rd.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  const sql = `SELECT ${RAW_DOCUMENT_COLUMNS.split(', ').map((c) => `rd.${c}`).join(', ')}
                 FROM raw_documents rd
                WHERE ${wheres.join(' AND ')}
                ORDER BY rd.created_at DESC, rd.id DESC
                LIMIT $2`;
  const result = await pool.query(sql, params);
  return slicePageWithCursor(result.rows.map(rowToRawDocument), limit);
}

/**
 * Apply the recovery-status default to any layer the caller omitted.
 * Empty arrays passed by the caller are kept verbatim so callers can
 * scope a layer out by passing `[]`.
 */
function mergeRecoveryFilter(
  override: DocumentRecoveryStatusFilter | undefined,
): Required<DocumentRecoveryStatusFilter> {
  if (!override) return DEFAULT_RECOVERY_STATUS_FILTER;
  return {
    extraction: override.extraction ?? DEFAULT_RECOVERY_STATUS_FILTER.extraction,
    semantic_index: override.semantic_index ?? DEFAULT_RECOVERY_STATUS_FILTER.semantic_index,
    raw_storage: override.raw_storage ?? DEFAULT_RECOVERY_STATUS_FILTER.raw_storage,
  };
}
