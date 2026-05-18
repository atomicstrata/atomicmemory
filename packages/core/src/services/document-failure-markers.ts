/**
 * Phase C constrained failure-marker transitions.
 *
 * `POST /v1/documents/:id/extraction-failure` and
 * `POST /v1/documents/:id/index-failure` need to be **constrained**
 * client-side surfaces, not arbitrary status writes - clients can
 * declare *that* extraction or indexing failed and *what category*,
 * but cannot put a document into arbitrary status combinations or
 * smuggle log content into `last_error`. This module owns the
 * load-then-transition logic for both endpoints:
 *
 *   1. Open a transaction and take the per-document
 *      `pg_advisory_xact_lock` so concurrent markers serialize.
 *   2. Load the row's raw / extraction / semantic-index status.
 *   3. Match the current state against the allowed source set and
 *      apply the corresponding write (or throw an
 *      `*InvalidStateError` -> 409).
 *   4. Read the row back and COMMIT so the caller can see the
 *      durable post-transition shape.
 *
 * The audit fix the Phase B plan calls out (rev 18 Phase C section):
 * the marker MUST sit in front of `markExtractionStatus` /
 * `markSemanticIndexStatus` so the row's status pair stays internally
 * consistent (e.g. `extraction='failed'` + `semantic_index='not_required'`
 * always travel together).
 */

import pg from 'pg';

import { getRawDocumentById } from '../db/raw-document-repository.js';
import {
  buildLastError,
  markExtractionStatus,
  markSemanticIndexStatus,
} from '../db/raw-document-status-repository.js';
import type {
  ExtractionStatus,
  RawDocumentRow,
  RawStorageStatus,
  SemanticIndexStatus,
} from '../db/raw-document-types.js';
import type {
  ExtractionErrorCode,
  IndexErrorCode,
} from '../schemas/documents.js';

/** State snapshot echoed in `*InvalidStateError` for 409 bodies. */
export interface DocumentLayerStateSnapshot {
  raw_storage_status: RawStorageStatus;
  extraction_status: ExtractionStatus;
  semantic_index_status: SemanticIndexStatus;
}

/** Document not found / not owned by user. Routes map to 404. */
export class FailureMarkerDocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} not found`);
    this.name = 'FailureMarkerDocumentNotFoundError';
  }
}

/**
 * Phase C - the row's current state does not allow the requested
 * extraction-layer transition. Routes map to 409 and echo `current`
 * in the response so the caller can decide whether to retry.
 */
export class ExtractionFailureInvalidStateError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly current: DocumentLayerStateSnapshot,
  ) {
    super(
      `document ${documentId} cannot transition to extraction_status='failed' ` +
        `from current state ${JSON.stringify(current)}`,
    );
    this.name = 'ExtractionFailureInvalidStateError';
  }
}

/**
 * Phase C - the row's current state does not allow the requested
 * index-layer transition. Routes map to 409 and echo `current` in
 * the response.
 */
export class IndexFailureInvalidStateError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly current: DocumentLayerStateSnapshot,
  ) {
    super(
      `document ${documentId} cannot transition to semantic_index_status='failed' ` +
        `from current state ${JSON.stringify(current)}`,
    );
    this.name = 'IndexFailureInvalidStateError';
  }
}

export interface MarkerInput<C> {
  userId: string;
  documentId: string;
  errorCode: C;
  errorMessage: string;
}

export interface MarkerResult {
  document: RawDocumentRow;
  /**
   * `true` when the row was already in the target failed state and
   * the call only refreshed `last_error` (or was a complete no-op
   * for same-code retries). `false` for a first-time transition.
   */
  idempotent: boolean;
}

/** Raw-storage states that mean "raw bytes are recoverable for retry / forensics". */
const RAW_OK: ReadonlySet<RawStorageStatus> = new Set<RawStorageStatus>([
  'blob_stored',
  'inline_text_stored',
  'pointer_recorded',
]);

function snapshot(row: RawDocumentRow): DocumentLayerStateSnapshot {
  return {
    raw_storage_status: row.rawStorageStatus,
    extraction_status: row.extractionStatus,
    semantic_index_status: row.semanticIndexStatus,
  };
}

async function withDocumentLock<T>(
  pool: pg.Pool,
  userId: string,
  documentId: string,
  body: (client: pg.PoolClient, row: RawDocumentRow) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
    const row = await getRawDocumentById(client, userId, documentId);
    if (!row) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new FailureMarkerDocumentNotFoundError(documentId);
    }
    let result: T;
    try {
      result = await body(client, row);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

async function reload(
  client: pg.PoolClient,
  userId: string,
  documentId: string,
): Promise<RawDocumentRow> {
  const row = await getRawDocumentById(client, userId, documentId);
  if (!row) {
    // Cannot happen inside the advisory lock unless the row was hard-
    // deleted by something outside this code path; treat as not-found
    // rather than corrupting the caller's flow.
    throw new FailureMarkerDocumentNotFoundError(documentId);
  }
  return row;
}

/**
 * Apply the indexer-layer `'failed'` write + reload-and-return the
 * fresh row. Used by both branches of `markIndexFailure` (idempotent
 * `last_error` refresh + first-time failure from pending) so the SQL
 * shape is owned in one place. The caller decides the `idempotent`
 * flag.
 */
async function applySemanticIndexFailedAndReload(args: {
  client: pg.PoolClient;
  userId: string;
  documentId: string;
  lastError: ReturnType<typeof buildLastError>;
  idempotent: boolean;
}): Promise<MarkerResult> {
  await markSemanticIndexStatus({
    q: args.client,
    userId: args.userId,
    documentId: args.documentId,
    status: 'failed',
    lastError: args.lastError,
  });
  const reloaded = await reload(args.client, args.userId, args.documentId);
  return { document: reloaded, idempotent: args.idempotent };
}

/**
 * Phase C constrained transition for the extraction layer.
 *
 * Allowed source states:
 *   * `extraction_status='failed'` + same `errorCode` -> idempotent
 *     no-op; caller sees the existing row with `idempotent: true`.
 *   * `extraction_status='failed'` + different `errorCode` -> refresh
 *     `last_error` only; status stays `'failed'`. `idempotent: true`.
 *   * `extraction_status='pending'` + raw stored ->
 *     `extraction_status='failed'` + `semantic_index_status='not_required'`
 *     + new `last_error.layer='extraction'`. `idempotent: false`.
 *
 * Any other state throws `ExtractionFailureInvalidStateError` (-> 409).
 */
export async function markExtractionFailure(
  pool: pg.Pool,
  input: MarkerInput<ExtractionErrorCode>,
): Promise<MarkerResult> {
  return withDocumentLock(pool, input.userId, input.documentId, async (client, row) => {
    const lastError = buildLastError('extraction', input.errorCode, input.errorMessage);

    // Branch 1: idempotent retry on an already-failed row.
    if (row.extractionStatus === 'failed') {
      const sameCode =
        row.lastError?.layer === 'extraction'
        && row.lastError.code === input.errorCode;
      if (sameCode) {
        // Same code: do not touch the row - preserves the original
        // `occurred_at` so per-incident timestamps stay stable across
        // retries from the same caller.
        return { document: row, idempotent: true };
      }
      // Different code (or stale envelope): refresh `last_error`.
      // `markExtractionStatus(failed, lastError)` writes the new
      // envelope unconditionally on the failed-status branch.
      await markExtractionStatus({
        q: client,
        userId: input.userId,
        documentId: input.documentId,
        status: 'failed',
        lastError,
      });
      const reloaded = await reload(client, input.userId, input.documentId);
      return { document: reloaded, idempotent: true };
    }

    // Branch 2: first-time failure from `'pending'` + raw stored.
    if (row.extractionStatus === 'pending' && RAW_OK.has(row.rawStorageStatus)) {
      await markExtractionStatus({
        q: client,
        userId: input.userId,
        documentId: input.documentId,
        status: 'failed',
        lastError,
      });
      // Failed extraction implies nothing to index. Service-owned
      // semantic-index status flip; the helper's success-branch
      // `last_error` clear ignores envelopes scoped to other layers,
      // so the extraction `last_error` we just wrote is preserved.
      await markSemanticIndexStatus({
        q: client,
        userId: input.userId,
        documentId: input.documentId,
        status: 'not_required',
      });
      const reloaded = await reload(client, input.userId, input.documentId);
      return { document: reloaded, idempotent: false };
    }

    // Anything else - 409.
    throw new ExtractionFailureInvalidStateError(input.documentId, snapshot(row));
  });
}

/**
 * Phase C constrained transition for the semantic-index layer.
 *
 * Allowed source states:
 *   * `semantic_index_status='failed'` + same `errorCode` -> idempotent
 *     no-op (`idempotent: true`).
 *   * `semantic_index_status='failed'` + different `errorCode` ->
 *     refresh `last_error` only; status stays `'failed'`.
 *     `idempotent: true`.
 *   * `extraction_status='complete'` +
 *     `semantic_index_status='pending'` + raw stored ->
 *     `semantic_index_status='failed'` +
 *     `last_error.layer='semantic_index'`. `idempotent: false`.
 *   * `extraction_status='pending'` +
 *     `semantic_index_status='pending'` AND
 *     `errorCode='index_text_too_large'` + raw stored -> atomically
 *     `extraction_status='complete'` +
 *     `semantic_index_status='failed'` + `last_error`. The
 *     atomic-extraction-complete shortcut models the upload-pipeline
 *     case where the webapp has the extracted text in hand but it
 *     exceeded the index byte cap before reaching `POST /:id/index`.
 *
 * Any other state -> `IndexFailureInvalidStateError` (-> 409).
 */
/** True when the row matches the "extraction completed, indexing pending" branch. */
function isCompleteThenPendingIndex(row: RawDocumentRow): boolean {
  return (
    row.extractionStatus === 'complete'
    && row.semanticIndexStatus === 'pending'
    && RAW_OK.has(row.rawStorageStatus)
  );
}

/** True when the row matches the upload-pipeline atomic shortcut branch. */
function isPendingPendingIndexTooLarge(
  row: RawDocumentRow,
  errorCode: IndexErrorCode,
): boolean {
  return (
    row.extractionStatus === 'pending'
    && row.semanticIndexStatus === 'pending'
    && RAW_OK.has(row.rawStorageStatus)
    && errorCode === 'index_text_too_large'
  );
}

/**
 * Idempotent-retry handler for a row already in
 * `semantic_index_status='failed'`. Same code -> no-op; different
 * code -> refresh `last_error`. Always reports `idempotent: true`.
 */
async function indexFailureIdempotentRetry(args: {
  client: pg.PoolClient;
  row: RawDocumentRow;
  input: MarkerInput<IndexErrorCode>;
  lastError: ReturnType<typeof buildLastError>;
}): Promise<MarkerResult> {
  const sameCode =
    args.row.lastError?.layer === 'semantic_index'
    && args.row.lastError.code === args.input.errorCode;
  if (sameCode) {
    return { document: args.row, idempotent: true };
  }
  return applySemanticIndexFailedAndReload({
    client: args.client,
    userId: args.input.userId,
    documentId: args.input.documentId,
    lastError: args.lastError,
    idempotent: true,
  });
}

/**
 * Atomic extraction-complete shortcut for the upload-pipeline
 * `index_text_too_large` case. Order matters within the transaction:
 *   1. `markExtractionStatus(complete)` clears any prior
 *      extraction-scoped `last_error` (none expected, but the
 *      helper guards regardless) and flips extraction.
 *   2. `markSemanticIndexStatus(failed, lastError)` writes the
 *      durable failure envelope. The two writes COMMIT together
 *      so external readers never observe the intermediate
 *      `extraction='complete'` + `semantic_index='pending'` state
 *      (the lock plus the single COMMIT serializes them).
 */
async function indexFailurePendingShortcut(args: {
  client: pg.PoolClient;
  input: MarkerInput<IndexErrorCode>;
  lastError: ReturnType<typeof buildLastError>;
}): Promise<MarkerResult> {
  await markExtractionStatus({
    q: args.client,
    userId: args.input.userId,
    documentId: args.input.documentId,
    status: 'complete',
  });
  return applySemanticIndexFailedAndReload({
    client: args.client,
    userId: args.input.userId,
    documentId: args.input.documentId,
    lastError: args.lastError,
    idempotent: false,
  });
}

export async function markIndexFailure(
  pool: pg.Pool,
  input: MarkerInput<IndexErrorCode>,
): Promise<MarkerResult> {
  return withDocumentLock(pool, input.userId, input.documentId, async (client, row) => {
    const lastError = buildLastError('semantic_index', input.errorCode, input.errorMessage);

    if (row.semanticIndexStatus === 'failed') {
      return indexFailureIdempotentRetry({ client, row, input, lastError });
    }
    if (isCompleteThenPendingIndex(row)) {
      return applySemanticIndexFailedAndReload({
        client,
        userId: input.userId,
        documentId: input.documentId,
        lastError,
        idempotent: false,
      });
    }
    if (isPendingPendingIndexTooLarge(row, input.errorCode)) {
      return indexFailurePendingShortcut({ client, input, lastError });
    }
    throw new IndexFailureInvalidStateError(input.documentId, snapshot(row));
  });
}
