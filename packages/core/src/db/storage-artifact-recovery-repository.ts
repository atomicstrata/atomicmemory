/**
 * @file Storage-level recovery-hint repository.
 *
 * `recordStorageUploadRecoveryHint` writes an
 * `internal_recovery_hint` envelope onto `storage_artifacts.last_error`
 * for a pending row, scoped by `(id, user_id, put_attempt_id)` CAS.
 * The helper exists as its own module (not folded into
 * `storage-artifact-repository.ts`) so the existing 800-line repo
 * file stays under the workspace LOC cap and so the recovery
 * envelope shape is documented in a single place.
 *
 * v1 path: reuses the existing `last_error` JSONB column. A
 * dedicated `storage_recovery_events` table is deferred — multi-step
 * recovery state machines can land that table when a real consumer
 * shows up.
 *
 * Document-side recovery (the rarer post-put orphan branch in
 * `storage-put-recovery.ts`) writes its own envelopes. This helper
 * is for non-document storage flows that produce a recovery hint
 * BEFORE the row leaves the `pending` state — direct
 * `POST /v1/storage/artifacts` uploads, the future Filecoin
 * readiness gate, etc. The envelope shape matches the existing
 * `{ layer, code, message, occurred_at }` contract so log readers
 * see one consistent shape.
 */

import type pg from 'pg';

/**
 * Closed type for the recovery hint code. New entries land here as
 * the contract grows; ad-hoc strings are rejected at the API
 * boundary so log consumers can rely on a stable enum.
 */
export type StorageUploadRecoveryHintCode =
  | 'manual_delete_required'
  | 'awaiting_provider_readiness'
  | 'awaiting_payment_authorization'
  | 'operator_intervention_required';

export interface StorageUploadRecoveryHintInput {
  readonly artifactId: string;
  readonly userId: string;
  readonly putAttemptId: string;
  readonly hint: StorageUploadRecoveryHintCode;
  readonly message?: string;
  readonly storageProvider?: string;
}

/**
 * Shape of the JSONB envelope written to `storage_artifacts.last_error`.
 * Exported so tests + downstream log consumers can construct or
 * inspect envelopes without re-typing the field set.
 */
export interface StorageUploadRecoveryHintEnvelope {
  readonly layer: 'raw_storage';
  readonly code: 'internal_recovery_hint';
  readonly internal_recovery_hint: StorageUploadRecoveryHintCode;
  readonly message: string;
  readonly storage_provider?: string;
  readonly occurred_at: string;
}

export function buildRecoveryHintEnvelope(
  input: StorageUploadRecoveryHintInput,
  now: () => Date = () => new Date(),
): StorageUploadRecoveryHintEnvelope {
  const envelope: StorageUploadRecoveryHintEnvelope = {
    layer: 'raw_storage',
    code: 'internal_recovery_hint',
    internal_recovery_hint: input.hint,
    message: input.message ?? input.hint,
    ...(input.storageProvider ? { storage_provider: input.storageProvider } : {}),
    occurred_at: now().toISOString(),
  };
  return envelope;
}

/**
 * CAS-write a recovery hint onto `storage_artifacts.last_error` for
 * a pending row. Returns `true` when the CAS matched (`id`,
 * `user_id`, `put_attempt_id`, `status='pending'`), `false` when
 * the row was finalized or claimed by another worker.
 *
 * The hint is RECORDED ONLY — this helper does not mutate `status`,
 * `put_attempt_id`, or any other column. The next phase (manual
 * operator intervention, retry, etc.) is responsible for clearing
 * or replacing the hint via the existing CAS helpers.
 */
export async function recordStorageUploadRecoveryHint(
  q: pg.Pool | pg.PoolClient,
  input: StorageUploadRecoveryHintInput,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const envelope = buildRecoveryHintEnvelope(input, now);
  const result = await q.query(
    `UPDATE storage_artifacts
       SET last_error = $4::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND put_attempt_id = $3
         AND status = 'pending'`,
    [input.artifactId, input.userId, input.putAttemptId, JSON.stringify(envelope)],
  );
  return (result.rowCount ?? 0) > 0;
}
