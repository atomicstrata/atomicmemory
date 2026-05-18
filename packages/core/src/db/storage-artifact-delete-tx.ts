/**
 * @file Paired DB transactions for `StorageService.deleteArtifact`'s
 * `policy=with_documents` finalization.
 *
 * Step 7 follow-up fix: the artifact's CAS-on-claim update and the
 * cascaded `raw_documents.raw_storage_status` propagation must
 * commit or roll back together. If they were two separate DB
 * operations a partial-commit could leave the artifact terminal
 * (`deleted` / `delete_failed`) while the linked raw_documents
 * stayed at `blob_stored`/`blob_available`, and the
 * `deleteArtifact` retry path would not heal it (a second DELETE
 * on a `deleted` artifact short-circuits early; a `delete_failed`
 * artifact skips the reference gate).
 *
 * Backend.delete itself runs OUTSIDE the transaction (it is a
 * network call); the DB finalization of `artifact + cascaded docs`
 * is what must be atomic.
 */

import pg from 'pg';
import {
  markDeleteFailed,
  markDeleteSuccess,
  type StorageArtifactRow,
} from './storage-artifact-repository.js';

export interface FinalizeArtifactDeleteSuccessInput {
  userId: string;
  artifactId: string;
  claimId: string;
  cascadedDocumentIds: ReadonlyArray<string>;
  /** Backend's delete semantics — drives the cascaded doc state. */
  semantics: 'deleted' | 'unpinned' | 'tombstoned';
}

export interface FinalizeArtifactDeleteFailureInput {
  userId: string;
  artifactId: string;
  claimId: string;
  cascadedDocumentIds: ReadonlyArray<string>;
  /** Error envelope for the artifact's `last_error` + each cascaded doc. */
  lastError: Record<string, unknown>;
}

/**
 * Success-path transaction. CAS-flips the artifact to `deleted` AND
 * advances every cascaded raw_documents row to its terminal
 * `blob_deleted` / `blob_tombstoned` state in one BEGIN..COMMIT.
 * Either both commit or both roll back; a partial-commit cannot
 * leave the rows in a drifted state.
 */
export async function finalizeArtifactDeleteSuccessTx(
  pool: pg.Pool,
  input: FinalizeArtifactDeleteSuccessInput,
): Promise<StorageArtifactRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const artifact = await markDeleteSuccess(client, {
      userId: input.userId,
      id: input.artifactId,
      claimId: input.claimId,
    });
    await propagateRawStorageTerminalWithClient(
      client,
      input.userId,
      input.cascadedDocumentIds,
      input.semantics,
    );
    await client.query('COMMIT');
    return artifact;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Failure-path transaction. CAS-flips the artifact to `delete_failed`
 * (recording `last_error`) AND advances every cascaded
 * raw_documents row to `raw_storage_failed` with the same envelope,
 * atomically.
 */
export async function finalizeArtifactDeleteFailureTx(
  pool: pg.Pool,
  input: FinalizeArtifactDeleteFailureInput,
): Promise<StorageArtifactRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const artifact = await markDeleteFailed(client, {
      userId: input.userId,
      id: input.artifactId,
      claimId: input.claimId,
      lastError: input.lastError,
    });
    await propagateRawStorageFailureWithClient(
      client,
      input.userId,
      input.cascadedDocumentIds,
      input.lastError,
    );
    await client.query('COMMIT');
    return artifact;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function propagateRawStorageTerminalWithClient(
  client: pg.PoolClient,
  userId: string,
  ids: ReadonlyArray<string>,
  semantics: 'deleted' | 'unpinned' | 'tombstoned',
): Promise<void> {
  if (ids.length === 0) return;
  const uniqueIds = Array.from(new Set(ids));
  const newStatus = semantics === 'deleted' ? 'blob_deleted' : 'blob_tombstoned';
  const result = await client.query(
    `UPDATE raw_documents
        SET raw_storage_status = $1, updated_at = NOW()
      WHERE user_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NOT NULL`,
    [newStatus, userId, uniqueIds],
  );
  assertCascadedRowCount(result.rowCount ?? 0, uniqueIds);
}

async function propagateRawStorageFailureWithClient(
  client: pg.PoolClient,
  userId: string,
  ids: ReadonlyArray<string>,
  lastError: Record<string, unknown>,
): Promise<void> {
  if (ids.length === 0) return;
  const uniqueIds = Array.from(new Set(ids));
  const result = await client.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'raw_storage_failed',
            last_error = $1::jsonb,
            updated_at = NOW()
      WHERE user_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NOT NULL`,
    [JSON.stringify(lastError), userId, uniqueIds],
  );
  assertCascadedRowCount(result.rowCount ?? 0, uniqueIds);
}

/**
 * Refuse to commit the paired tx when the cascaded raw_documents
 * UPDATE matched fewer rows than the caller asked us to propagate
 * onto. SQL UPDATE success is not semantic success — a stale id,
 * wrong-owner id, or not-yet-soft-deleted id would otherwise let the
 * artifact finalize as `deleted` / `delete_failed` while at least
 * one intended raw_document stayed at `blob_stored` / `blob_available`,
 * and no retry path heals that drift. Throwing rolls back the whole
 * tx so caller + DB stay consistent.
 */
function assertCascadedRowCount(
  matched: number,
  uniqueIds: ReadonlyArray<string>,
): void {
  if (matched === uniqueIds.length) return;
  throw new CascadedRawDocumentMismatchError(matched, uniqueIds);
}

export class CascadedRawDocumentMismatchError extends Error {
  constructor(
    public readonly matched: number,
    public readonly expectedIds: ReadonlyArray<string>,
  ) {
    super(
      `finalize cascade matched ${matched} of ${expectedIds.length} raw_documents ` +
        `(ids: ${expectedIds.join(', ')}) — refusing to finalize artifact while ` +
        'a cascaded row remains stale',
    );
    this.name = 'CascadedRawDocumentMismatchError';
  }
}
