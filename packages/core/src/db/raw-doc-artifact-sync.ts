/**
 * @file Sync hook keeping `storage_artifacts.status` in lockstep
 * with `raw_documents.raw_storage_status`.
 *
 * Step 7 of the storage-sibling plan. Every existing raw-storage
 * transition (upload finalize, reconciler success/failure, cleanup
 * success/failure) calls this hook after mutating `raw_documents`
 * so the paired `storage_artifacts` row tracks the same lifecycle.
 *
 * v1 keeps `raw_documents` as the source of truth for document-
 * backed uploads — the artifact row is a synchronized projection.
 * The follow-up Webapp Storage UI PR (source plan Phase 8) makes
 * `storage_artifacts` the source of truth and switches the document
 * formatter to a join-projection. Until then, the helper guarantees
 * both rows agree.
 *
 * Status mapping (plan rev 6 §Step 7):
 *
 *   pointer_recorded (with external_uri / pointer artifact) → 'stored'
 *   pointer_recorded (no artifact linked)                   → no-op
 *   blob_stored                                              → 'stored'
 *   blob_pending                                             → 'pending'
 *   blob_uploading                                           → 'pending' (transient)
 *   blob_available                                           → 'available'
 *   blob_archival_failed                                     → 'failed'
 *   raw_storage_failed                                       → 'failed'
 *   blob_tombstoned                                          → 'deleted'
 *   blob_deleted                                             → 'deleted'
 *   inline_text_stored                                       → no-op (inline; no artifact)
 */

import type pg from 'pg';
import type { RawStorageStatus } from './raw-document-types.js';
import {
  markDeleteFailed,
  markDeleteSuccess,
  type StorageArtifactRow,
  type StorageArtifactStatus,
} from './storage-artifact-repository.js';
import {
  markArchivalFailedWithClient,
  promoteToAvailableWithClient,
} from './raw-storage-reconciliation-repository.js';
import { buildLastError } from './raw-document-status-repository.js';

/**
 * Canonical raw_storage cleanup-failure envelope. Persisted to both
 * `raw_documents.last_error` (via `markCleanupFailedAndSyncArtifact`)
 * and the linked `storage_artifacts.last_error`. The provider's raw
 * exception message is funneled through `buildLastError` so the
 * central `sanitizeLastErrorMessage` cap (1 KiB) and control-char
 * collapse apply uniformly — multi-line stack traces, sensitive
 * URLs in error blobs, and oversized provider envelopes never reach
 * the JSONB column unfiltered. The `storage_provider` field is
 * appended after sanitization so the envelope shape stays
 * additive on top of the canonical `LastError`.
 */
export function buildRawStorageCleanupFailureEnvelope(
  message: string,
  storageProvider: string,
): Record<string, unknown> {
  return {
    ...buildLastError('raw_storage', 'managed_blob_cleanup_failed', message),
    storage_provider: storageProvider,
  };
}

const STATUS_MAP: Readonly<Partial<Record<RawStorageStatus, StorageArtifactStatus>>> = {
  pointer_recorded: 'stored',
  blob_stored: 'stored',
  blob_pending: 'pending',
  blob_uploading: 'pending',
  blob_available: 'available',
  blob_archival_failed: 'failed',
  raw_storage_failed: 'failed',
  blob_tombstoned: 'deleted',
  blob_deleted: 'deleted',
};

export interface SyncArtifactStatusInput {
  rawDocumentId: string;
  newRawStatus: RawStorageStatus;
  /**
   * Optional failure envelope to record on the artifact's
   * `last_error` column. Pass only on failure transitions; the
   * helper clears `last_error` on success transitions (`stored` /
   * `pending` / `available` / `deleted`).
   */
  lastError?: Record<string, unknown>;
}

/**
 * Map a single `raw_documents` row's new status onto its linked
 * `storage_artifacts` row. Resolves the link inside the same query
 * pair (no separate read) so the hook is safe to call inside the
 * existing transactions that wrap the raw-storage transitions.
 *
 * No-op (silently) when:
 *   - the document is not linked to an artifact (`storage_artifact_id IS NULL`),
 *   - the new raw status maps to no artifact state (e.g. `inline_text_stored`).
 *
 * The function deliberately does NOT scope by `user_id` — the
 * caller has already vouched for the row by holding the row's
 * advisory lock or having authenticated the request that triggered
 * the transition.
 */
export async function syncArtifactStatusFromRawDocument(
  client: pg.PoolClient | pg.Pool,
  args: SyncArtifactStatusInput,
): Promise<void> {
  const mapped = STATUS_MAP[args.newRawStatus];
  if (mapped === undefined) return;
  const lookup = await client.query<{ storage_artifact_id: string | null }>(
    `SELECT storage_artifact_id FROM raw_documents WHERE id = $1`,
    [args.rawDocumentId],
  );
  if (lookup.rowCount === 0) return;
  const artifactId = lookup.rows[0].storage_artifact_id;
  if (artifactId === null) return;
  await applyArtifactTransition(client, artifactId, mapped, args.lastError);
}

/**
 * Reconciler paired promote: flip the document to `blob_available`
 * AND sync the artifact in one transaction. Two-row drift is
 * impossible — either both rows commit or both roll back.
 */
export async function promoteAndSyncArtifact(
  pool: pg.Pool,
  args: {
    rowId: string;
    claimId: string;
    provider: string;
    providerFields: Record<string, unknown>;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowCount = await promoteToAvailableWithClient(client, args);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.rowId,
      newRawStatus: 'blob_available',
    });
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reconciler paired archival-fail: flip the document to
 * `blob_archival_failed` AND sync the artifact (with the
 * `last_error` envelope) in one transaction.
 */
export async function markArchivalFailedAndSyncArtifact(
  pool: pg.Pool,
  args: {
    rowId: string;
    claimId: string;
    lastError: Record<string, unknown>;
    provider: string;
  },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowCount = await markArchivalFailedWithClient(client, args);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.rowId,
      newRawStatus: 'blob_archival_failed',
      lastError: args.lastError,
    });
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Document-keyed paired marker for the cleanup path. Each blob
 * cleanup carries its `rawDocumentId` (see
 * `ManagedBlobRefRow.rawDocumentId`) so the sync never needs to
 * disambiguate by URI. The raw_documents UPDATE is owner-scoped;
 * if zero rows match (cross-user mismatch or already-terminal),
 * the artifact sync is skipped — preventing a mismatched caller
 * from flipping another user's artifact.
 */
export async function markCleanupSuccessAndSyncArtifact(
  pool: pg.Pool,
  args: {
    userId: string;
    rawDocumentId: string;
    storageUri: string;
    semantics: 'deleted' | 'unpinned' | 'tombstoned';
  },
): Promise<void> {
  const newRawStatus: RawStorageStatus =
    args.semantics === 'deleted' ? 'blob_deleted' : 'blob_tombstoned';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE raw_documents
          SET raw_storage_status = $1, updated_at = NOW()
        WHERE user_id = $2 AND id = $3`,
      [newRawStatus, args.userId, args.rawDocumentId],
    );
    if ((result.rowCount ?? 0) === 0) {
      // Cross-user mismatch or row missing — leave the artifact
      // untouched. The link belongs to another user (or no row);
      // mirroring through id-only would clobber theirs.
      await client.query('ROLLBACK');
      return;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.rawDocumentId,
      newRawStatus,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Document-keyed paired failure marker. Mirrors
 * `markCleanupSuccessAndSyncArtifact` but for the failure branch
 * (`raw_storage_failed`). Same owner-scope gating.
 *
 * Retry-friendly: the UPDATE matches on `(user_id, id)` only — a row
 * that is ALREADY `raw_storage_failed` is re-marked so a fresh
 * provider error replaces the prior envelope on both
 * `raw_documents.last_error` AND the linked
 * `storage_artifacts.last_error`. Mirrors the failure-marker pattern
 * elsewhere in the codebase, where retries land the newest, most-
 * useful error rather than discarding it. Cross-user mismatches
 * still roll back via the owner-scoped WHERE.
 */
export async function markCleanupFailedAndSyncArtifact(
  pool: pg.Pool,
  args: {
    userId: string;
    rawDocumentId: string;
    lastError?: Record<string, unknown>;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasError = args.lastError !== undefined;
    const result = await client.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'raw_storage_failed',
              last_error = CASE WHEN $3::boolean THEN $4::jsonb ELSE last_error END,
              updated_at = NOW()
        WHERE user_id = $1 AND id = $2`,
      [
        args.userId,
        args.rawDocumentId,
        hasError,
        hasError ? JSON.stringify(args.lastError) : null,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.rawDocumentId,
      newRawStatus: 'raw_storage_failed',
      lastError: args.lastError,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function applyArtifactTransition(
  client: pg.PoolClient | pg.Pool,
  artifactId: string,
  mapped: StorageArtifactStatus,
  lastError: Record<string, unknown> | undefined,
): Promise<void> {
  if (mapped === 'deleted') {
    await client.query(
      `UPDATE storage_artifacts
         SET status = 'deleted',
             deleted_at = COALESCE(deleted_at, NOW()),
             delete_attempt_id = NULL,
             updated_at = NOW()
         WHERE id = $1`,
      [artifactId],
    );
    return;
  }
  if (mapped === 'failed') {
    await client.query(
      `UPDATE storage_artifacts
         SET status = 'failed',
             last_error = COALESCE($2::jsonb, last_error),
             updated_at = NOW()
         WHERE id = $1`,
      [artifactId, lastError === undefined ? null : JSON.stringify(lastError)],
    );
    return;
  }
  // Success transitions clear last_error so a retry path doesn't
  // surface a stale envelope alongside `status='available'`.
  await client.query(
    `UPDATE storage_artifacts
       SET status = $2,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
    [artifactId, mapped],
  );
}
