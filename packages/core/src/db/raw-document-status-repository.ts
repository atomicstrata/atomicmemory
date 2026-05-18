/**
 * Per-layer status repository helpers (Phase B).
 *
 * The audit at
 * `the document ingest audit notes`
 * and the rev-18 hardening plan call for **service-owned** transitions
 * of `extraction_status`, `semantic_index_status`, `raw_storage_status`
 * and the `last_error` JSONB envelope. This module exposes the SQL
 * primitives that the indexer (`document-indexer.ts`), the upload
 * service (`document-upload.ts`), and any future async worker call to
 * record those transitions.
 *
 * Design notes (cross-referenced from the plan):
 *
 *   * Each helper accepts `pg.Pool | pg.PoolClient` so it works inside
 *     an in-flight transaction (e.g. the indexer's running-tx) and
 *     from a **fresh** statement after a parent rolled back. The catch
 *     paths in `document-upload.ts` and `document-indexer.ts` use the
 *     fresh-statement form deliberately so the durable failure write
 *     survives the rollback that drops the in-tx work.
 *
 *   * Mark helpers are scoped by `user_id` + `id` and skip soft-deleted
 *     rows. They are **idempotent** at the SQL level - re-applying the
 *     same status (e.g. `'failed'` -> `'failed'` with the same code)
 *     returns the row unchanged.
 *
 *   * `last_error` write rule: a failure transition writes the supplied
 *     envelope; a success transition clears `last_error` **only when
 *     the existing envelope was scoped to the same layer**. A
 *     successful semantic-index pass should not silently erase a
 *     previous extraction failure that someone else still needs to
 *     reconcile.
 */

import pg from 'pg';

import type {
  ExtractionStatus,
  LastError,
  LastErrorLayer,
  SemanticIndexStatus,
} from './raw-document-types.js';

/** Pool or in-flight client - matches the union the rest of the repo uses. */
type Querier = pg.Pool | pg.PoolClient;

interface MarkArgs {
  q: Querier;
  userId: string;
  documentId: string;
}

/**
 * Update `extraction_status` on an active row. Pass `lastError` for
 * failure / unsupported transitions; success transitions clear the
 * column when the prior `last_error` was scoped to the extraction
 * layer.
 */
export async function markExtractionStatus(
  args: MarkArgs & { status: ExtractionStatus; lastError?: LastError | null },
): Promise<void> {
  const { q, userId, documentId, status, lastError } = args;
  const isFailure = status === 'failed' || status === 'unsupported';
  if (isFailure && !lastError) {
    throw new Error(
      `markExtractionStatus: lastError is required for status '${status}'`,
    );
  }
  if (isFailure) {
    await q.query(
      `UPDATE raw_documents
          SET extraction_status = $1,
              last_error = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL`,
      [status, JSON.stringify(lastError), documentId, userId],
    );
    return;
  }
  // Success / interim - selectively clear last_error.
  await q.query(
    `UPDATE raw_documents
        SET extraction_status = $1,
            last_error = CASE
              WHEN last_error IS NOT NULL AND last_error->>'layer' = 'extraction'
              THEN NULL
              ELSE last_error
            END,
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [status, documentId, userId],
  );
}

/**
 * Update `semantic_index_status` on an active row. Same `last_error`
 * scoping rule as {@link markExtractionStatus} - a successful
 * indexing pass clears the column only when it was last set by the
 * semantic-index layer.
 */
export async function markSemanticIndexStatus(
  args: MarkArgs & { status: SemanticIndexStatus; lastError?: LastError | null },
): Promise<void> {
  const { q, userId, documentId, status, lastError } = args;
  const isFailure = status === 'failed';
  if (isFailure && !lastError) {
    throw new Error(
      `markSemanticIndexStatus: lastError is required for status '${status}'`,
    );
  }
  if (isFailure) {
    await q.query(
      `UPDATE raw_documents
          SET semantic_index_status = $1,
              last_error = $2::jsonb,
              updated_at = NOW()
        WHERE id = $3 AND user_id = $4 AND deleted_at IS NULL`,
      [status, JSON.stringify(lastError), documentId, userId],
    );
    return;
  }
  await q.query(
    `UPDATE raw_documents
        SET semantic_index_status = $1,
            last_error = CASE
              WHEN last_error IS NOT NULL AND last_error->>'layer' = 'semantic_index'
              THEN NULL
              ELSE last_error
            END,
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [status, documentId, userId],
  );
}

/**
 * Mark a row as `raw_storage_status='raw_storage_failed'` from a
 * **document id** (not a storage URI). The audit fix the upload
 * service relies on: when `store.put` throws before returning a URI
 * the URI-keyed marker can't fire, so this doc-id form lives next to
 * it and runs in the catch path of `uploadRawDocument` in a fresh
 * statement after the parent transaction rolled back.
 */
export async function markRawStorageFailedByDocumentId(
  args: MarkArgs & { lastError: LastError },
): Promise<void> {
  const { q, userId, documentId, lastError } = args;
  await q.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'raw_storage_failed',
            last_error = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [JSON.stringify(lastError), documentId, userId],
  );
}

/**
 * Clear `last_error` on a row when the existing envelope is scoped to
 * `layer`. Optional helper for retry paths that want to reset only
 * one layer's failure marker without touching status fields.
 */
export async function clearLastError(
  args: MarkArgs & { layer: LastErrorLayer },
): Promise<void> {
  const { q, userId, documentId, layer } = args;
  await q.query(
    `UPDATE raw_documents
        SET last_error = NULL,
            updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
        AND last_error IS NOT NULL
        AND last_error->>'layer' = $3`,
    [documentId, userId, layer],
  );
}

/**
 * Hard cap on the persisted `last_error.message` length (UTF-16 code
 * units, the JS string-length unit). Producer-facing failure messages
 * vary widely - DB-driver stack traces, embedding-provider error
 * blobs, file-extractor exceptions - and persisting them verbatim
 * risks (a) blowing JSONB row-size budgets on operational noise and
 * (b) leaking sensitive operational strings (URIs, keys baked into
 * exception messages). This cap is the central knob; producers funnel
 * through {@link buildLastError} so the cap applies uniformly to every
 * `last_error` write.
 *
 * The number is sized to fit a useful human-readable detail line
 * (e.g. one stack-frame's worth of context) without becoming a
 * dumping ground for raw exception text.
 */
export const MAX_LAST_ERROR_MESSAGE_CHARS = 1000;

/**
 * Normalize a producer-supplied error message before persisting it on
 * `raw_documents.last_error`:
 *   * control chars (including TAB, CR, LF, and NUL) are replaced
 *     with a single space - keeps multi-line stack traces from
 *     breaking the UI's row layout and prevents NUL bytes from
 *     reaching clients that mishandle them;
 *   * runs of whitespace collapse to a single space - the message
 *     reads as a single line of operator detail;
 *   * the result is truncated to {@link MAX_LAST_ERROR_MESSAGE_CHARS}
 *     code units. No truncation marker is appended; readers compare
 *     against the cap if they want to flag truncation client-side.
 *
 * Exported so producer-side code paths (route handlers, services
 * that need to build envelopes outside `buildLastError`) can apply
 * the same sanitization rule without re-implementing it.
 */
export function sanitizeLastErrorMessage(raw: string): string {
  // Replace any character at code point < 0x20 OR DEL (0x7f) with a
  // single space. Covers ASCII control chars including \r, \n, \t,
  // \0; preserves all printable / non-control Unicode glyphs.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, ' ');
  const collapsed = stripped.replace(/ {2,}/g, ' ').trim();
  if (collapsed.length <= MAX_LAST_ERROR_MESSAGE_CHARS) return collapsed;
  return collapsed.slice(0, MAX_LAST_ERROR_MESSAGE_CHARS);
}

/**
 * Build a `LastError` envelope. Producers should funnel through this
 * helper so the wire / JSONB shape stays uniform AND the message is
 * sanitized + capped (see {@link sanitizeLastErrorMessage}).
 */
export function buildLastError(
  layer: LastErrorLayer,
  code: string,
  message: string,
  occurredAt: Date = new Date(),
): LastError {
  return {
    layer,
    code,
    message: sanitizeLastErrorMessage(message),
    occurred_at: occurredAt.toISOString(),
  };
}
