/**
 * @file Pending-row-first put recovery helpers for `StorageService`.
 *
 * `storage-service.ts` orchestrates managed-mode puts: claim a
 * pending row, call `backend.put`, finalize via a CAS to `'stored'`.
 * This module owns every branch the orchestrator hands off to when
 * something on either side fails, plus the closed-set event names
 * the helpers emit:
 *
 *   - `persistUploadedOrRecover` — happy success + retry, then
 *     reconciliation (commit-after-throw), then recovery.
 *   - `recordBackendPutFailure` — `backend.put` threw before
 *     finalization; CAS-flip to `'failed'`.
 *   - the post-put recovery branches (cleanup OK / cleanup failed)
 *     and the durable orphan-URI marker that the reconciler reads.
 *
 * Extracted from `storage-service.ts` to keep that file under the
 * workspace 400-LOC cap. No behavior change vs the inline form.
 */

import type pg from 'pg';
import {
  getStorageArtifactByIdIncludingDeleted,
  markPutFailed,
  recordUploadedArtifact,
  type StorageArtifactRow,
} from '../db/storage-artifact-repository.js';
import type { PutBackendResult, StorageBackend } from '../storage/storage-backend.js';
import { projectArtifactProviderFields } from '../storage/provider-metadata-projection.js';
import { PutPostPersistError } from './storage-service-errors.js';

/** Re-export of the backend `put` result shape used by the recovery helpers. */
export type PutResult = PutBackendResult;

/**
 * Closed enum of structured-log event names emitted by the put
 * recovery pipeline. Adding a name here is the explicit permission
 * to surface it in the `[STORAGE]` log stream; the TS checker
 * blocks accidental typos.
 */
export type StorageEventName =
  | 'storage.put.post_put_unrecoverable'
  | 'storage.put.post_put_failed_cleaned_up'
  | 'storage.put.post_put_unrecoverable_mark_error'
  | 'storage.put.post_put_failed_cleaned_up_mark_error'
  | 'storage.put.backend_put_failed_mark_skipped'
  | 'storage.put.backend_put_failed_mark_error';

/**
 * Subset of `StorageEventName` reserved for the shared
 * `runScopedFailureMarker` DB-error fallback. Pinning the type at
 * the helper boundary keeps a future caller from emitting an
 * unrelated event name through that surface.
 */
type ScopedFailureMarkerEvent =
  | 'storage.put.post_put_unrecoverable_mark_error'
  | 'storage.put.post_put_failed_cleaned_up_mark_error';

/** Emit a structured `[STORAGE]` event to stderr (one JSON line). */
function emitStorageEvent(
  event: StorageEventName,
  detail: Record<string, unknown>,
): void {
  const payload = { event, timestamp: new Date().toISOString(), detail };
  process.stderr.write(`[STORAGE] ${JSON.stringify(payload)}\n`);
}

/**
 * Normalize an arbitrary thrown value into a single-line string.
 * Exported because `StorageService.executeBackendDelete` also
 * needs to format `backend.delete` errors into `last_error`
 * envelopes; the function shape is identical to the one the
 * recovery helpers use so they share a single implementation.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown error');
}

export interface PutClaim {
  row: StorageArtifactRow;
  claimId: string;
}

/**
 * Success-path orchestrator: CAS-flip the pending row to `stored`,
 * with one retry. On every failure mode (throw, CAS miss, or the
 * commit-after-throw race) call `reconcileAlreadyFinalized` BEFORE
 * recovery so an already-finalized row is not erroneously cleaned
 * up.
 */
export async function persistUploadedOrRecover(args: {
  pool: pg.Pool;
  userId: string;
  backend: StorageBackend;
  claim: PutClaim;
  putResult: PutResult;
}): Promise<StorageArtifactRow> {
  const projected = projectArtifactProviderFields(
    args.backend.provider,
    args.putResult.providerMetadata,
  );
  const recordInput = {
    userId: args.userId,
    artifactId: args.claim.row.id,
    putAttemptId: args.claim.claimId,
    uri: args.putResult.uri,
    sizeBytes: args.putResult.sizeBytes,
    plaintextHash: args.putResult.plaintextHash,
    storedHash: args.putResult.storedHash,
    identifiers: projected.identifiers,
    providerDetails: projected.providerDetails,
  };
  let firstError: unknown;
  try {
    const recorded = await recordUploadedArtifact(args.pool, recordInput);
    if (recorded !== null) return recorded;
  } catch (err) {
    firstError = err;
  }
  const reconciled = await reconcileAlreadyFinalized(args.pool, args.userId, args.claim.row.id, args.putResult);
  if (reconciled !== null) return reconciled;
  let retryError: unknown;
  try {
    const retried = await recordUploadedArtifact(args.pool, recordInput);
    if (retried !== null) return retried;
  } catch (err) {
    retryError = err;
  }
  const reconciledAfterRetry = await reconcileAlreadyFinalized(
    args.pool, args.userId, args.claim.row.id, args.putResult,
  );
  if (reconciledAfterRetry !== null) return reconciledAfterRetry;
  // Synthesize a typed error so recovery has a meaningful message
  // when both calls returned null without throwing. URI stays
  // server-side; only the artifact id is in the message.
  const persistError = firstError ?? retryError ?? new Error(
    `recordUploadedArtifact CAS missed twice for artifact '${args.claim.row.id}' ` +
      'and the row was not reconcilable; treating as post-put DB failure',
  );
  return recoverPostPutFailure({
    pool: args.pool,
    userId: args.userId,
    claim: args.claim,
    backend: args.backend,
    putResult: args.putResult,
    persistError,
  });
}

/**
 * Commit-after-throw reconciliation. Reads the row by id (within
 * the user scope) and returns it if `status='stored'` AND its
 * `(uri, plaintextHash, storedHash)` match the bytes we just
 * uploaded. Returns null otherwise.
 */
async function reconcileAlreadyFinalized(
  pool: pg.Pool,
  userId: string,
  artifactId: string,
  putResult: PutResult,
): Promise<StorageArtifactRow | null> {
  const row = await getStorageArtifactByIdIncludingDeleted(pool, userId, artifactId);
  if (row === null) return null;
  if (row.status !== 'stored') return null;
  if (row.uri !== putResult.uri) return null;
  if (row.plaintextHash !== putResult.plaintextHash) return null;
  if (row.storedHash !== putResult.storedHash) return null;
  return row;
}

/**
 * Cleanup-then-mark recovery. Attempts `backend.delete(uri)` to
 * roll back the just-uploaded bytes; depending on the outcome
 * either marks the row `failed` with `put_post_persist_failed_cleaned_up`
 * and re-throws the original DB error, OR persists a durable
 * `put_post_persist_unrecoverable` marker (with the orphan URI on
 * the internal `last_error` envelope) and throws `PutPostPersistError`.
 */
async function recoverPostPutFailure(args: {
  pool: pg.Pool;
  userId: string;
  claim: PutClaim;
  backend: StorageBackend;
  putResult: PutResult;
  persistError: unknown;
}): Promise<never> {
  const persistMessage = errorMessage(args.persistError);
  try {
    await args.backend.delete(args.putResult.uri);
  } catch (cleanupError) {
    await markPostPutUnrecoverableBestEffort({
      pool: args.pool,
      userId: args.userId,
      artifactId: args.claim.row.id,
      putAttemptId: args.claim.claimId,
      provider: args.backend.provider,
      uri: args.putResult.uri,
      persistMessage,
      cleanupMessage: errorMessage(cleanupError),
    });
    throw new PutPostPersistError(
      args.claim.row.id, args.backend.provider, args.putResult.uri, persistMessage,
    );
  }
  await markCleanedUpBestEffort({
    pool: args.pool,
    userId: args.userId,
    artifactId: args.claim.row.id,
    putAttemptId: args.claim.claimId,
    provider: args.backend.provider,
    persistMessage,
  });
  throw args.persistError;
}

async function markCleanedUpBestEffort(args: {
  pool: pg.Pool;
  userId: string;
  artifactId: string;
  putAttemptId: string;
  provider: string;
  persistMessage: string;
}): Promise<void> {
  const envelope = {
    layer: 'raw_storage',
    code: 'put_post_persist_failed_cleaned_up',
    message: args.persistMessage,
    storage_provider: args.provider,
    occurred_at: new Date().toISOString(),
  };
  const matched = await runScopedFailureMarker({
    pool: args.pool,
    userId: args.userId,
    artifactId: args.artifactId,
    putAttemptId: args.putAttemptId,
    envelope,
    dbErrorEvent: 'storage.put.post_put_failed_cleaned_up_mark_error',
  });
  if (!matched) {
    emitStorageEvent('storage.put.post_put_failed_cleaned_up', {
      artifact_id: args.artifactId,
      provider: args.provider,
      persist_error: args.persistMessage,
      reason: 'cas_miss_or_db_error',
    });
  }
}

async function markPostPutUnrecoverableBestEffort(args: {
  pool: pg.Pool;
  userId: string;
  artifactId: string;
  putAttemptId: string;
  provider: string;
  uri: string;
  persistMessage: string;
  cleanupMessage: string;
}): Promise<void> {
  const envelope = {
    layer: 'raw_storage',
    code: 'put_post_persist_unrecoverable',
    message: args.persistMessage,
    cleanup_error: args.cleanupMessage,
    orphan_uri: args.uri,
    storage_provider: args.provider,
    occurred_at: new Date().toISOString(),
  };
  const matched = await runScopedFailureMarker({
    pool: args.pool,
    userId: args.userId,
    artifactId: args.artifactId,
    putAttemptId: args.putAttemptId,
    envelope,
    dbErrorEvent: 'storage.put.post_put_unrecoverable_mark_error',
  });
  emitStorageEvent('storage.put.post_put_unrecoverable', {
    artifact_id: args.artifactId,
    provider: args.provider,
    uri: args.uri,
    persist_error: args.persistMessage,
    cleanup_error: args.cleanupMessage,
    marker_persisted: matched,
  });
}

/** Shared CAS-scoped failure marker — CAS on
 *  `(id, user_id, put_attempt_id, status='pending')`. Emits the
 *  supplied typed event on DB error; never swallows. */
async function runScopedFailureMarker(args: {
  pool: pg.Pool;
  userId: string;
  artifactId: string;
  putAttemptId: string;
  envelope: Record<string, unknown>;
  dbErrorEvent: ScopedFailureMarkerEvent;
}): Promise<boolean> {
  try {
    const result = await args.pool.query(
      `UPDATE storage_artifacts
         SET status = 'failed',
             last_error = $4::jsonb,
             put_attempt_id = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND user_id = $2
           AND put_attempt_id = $3
           AND status = 'pending'`,
      [args.artifactId, args.userId, args.putAttemptId, JSON.stringify(args.envelope)],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (markError) {
    emitStorageEvent(args.dbErrorEvent, {
      artifact_id: args.artifactId,
      mark_error: errorMessage(markError),
    });
    return false;
  }
}

/**
 * Failure branch invoked from `putManaged` when `backend.put`
 * itself threw. CAS-flip the pending row to `'failed'`. If the CAS
 * marker misses or its UPDATE throws, emit a typed event so the
 * failure stays observable; the caller re-throws the original put
 * error regardless.
 */
export async function recordBackendPutFailure(args: {
  pool: pg.Pool;
  userId: string;
  claim: PutClaim;
  provider: string;
  putError: unknown;
}): Promise<void> {
  const envelope = {
    layer: 'raw_storage',
    code: 'backend_put_failed',
    message: errorMessage(args.putError),
    storage_provider: args.provider,
    occurred_at: new Date().toISOString(),
  };
  try {
    const marked = await markPutFailed(args.pool, {
      userId: args.userId,
      artifactId: args.claim.row.id,
      putAttemptId: args.claim.claimId,
      lastError: envelope,
    });
    if (marked !== null) return;
    emitStorageEvent('storage.put.backend_put_failed_mark_skipped', {
      artifact_id: args.claim.row.id,
      provider: args.provider,
      reason: 'cas_miss',
      put_error: envelope.message,
    });
  } catch (markError) {
    emitStorageEvent('storage.put.backend_put_failed_mark_error', {
      artifact_id: args.claim.row.id,
      provider: args.provider,
      put_error: envelope.message,
      mark_error: errorMessage(markError),
    });
  }
}
