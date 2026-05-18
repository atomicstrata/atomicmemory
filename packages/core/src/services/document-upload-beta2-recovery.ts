/**
 * Phase β2 orphan-bytes compensation + raw-document failure-marker
 * helpers for the managed-blob upload pipeline.
 *
 * Extracted from `document-upload.ts` so the orchestration module
 * stays under the workspace 400-non-comment-LOC cap. The two
 * exported helpers cover the post-`store.put` failure window:
 *
 *   - `compensateOrphanedBlob` runs a best-effort `store.delete`
 *     for bytes that were durably written but never linked
 *     (e.g. the prior artifact entered a delete lifecycle between
 *     our claim and the swap, so `ArtifactNotLinkableError` fires).
 *   - `markBeta2FailureOnDocument` flips the raw_document to
 *     `raw_storage_failed` with a typed envelope so the public
 *     status surfaces stop saying "upload in progress" for a doc
 *     whose upload actually failed. When cleanup also failed the
 *     envelope carries `internal_recovery_hint` so a reconciler /
 *     ops can find the abandoned bytes. The wire formatter
 *     (`document-response-formatters.ts`) strips `internal_*`
 *     keys before exposing `last_error` on the public response.
 */

import type pg from 'pg';
import { failClaimedUploadWithClient } from '../db/raw-document-blob-repository.js';
import type { StoredRawContent } from '../storage/raw-content-store.js';
import type { RawContentStore } from '../storage/raw-content-store.js';
import type { RawDocumentRow } from '../db/raw-document-types.js';
import { describeError } from './upload-helpers.js';

export type Beta2Compensation =
  | { cleanupSucceeded: true }
  | { cleanupSucceeded: false; cleanupError: string };

/**
 * Best-effort `store.delete` for the orphan-bytes window between
 * `store.put` returning and `recordUploadResultAndSwapArtifact`
 * committing the artifact swap. Returns whether cleanup succeeded
 * (the caller uses this to decide whether to embed the orphan
 * URI/provider in the raw_document's recovery-hint envelope).
 *
 * A cleanup failure is also logged with the originating error so
 * a `grep '[STORAGE]'` operator can correlate.
 */
export async function compensateOrphanedBlob(
  store: RawContentStore,
  storageUri: string,
  documentId: string,
  cause: unknown,
): Promise<Beta2Compensation> {
  try {
    await store.delete(storageUri);
    return { cleanupSucceeded: true };
  } catch (cleanupErr) {
    const cleanupErrorMessage = describeError(cleanupErr);
    // eslint-disable-next-line no-console
    console.error(
      `runPhaseBeta2: failed to compensate orphan blob ` +
        `(documentId=${documentId}, storageUri=${storageUri}) after ` +
        `${describeError(cause)}; cleanup error: ${cleanupErrorMessage}`,
    );
    return { cleanupSucceeded: false, cleanupError: cleanupErrorMessage };
  }
}

export interface Beta2FailureMarkerArgs {
  pool: pg.Pool;
  document: Pick<RawDocumentRow, 'id' | 'userId'>;
  claimId: string;
  stored: StoredRawContent & { codecMetadata: Record<string, unknown> };
  reasonCode: 'artifact_not_linkable' | 'beta2_swap_failed';
  reasonMessage: string;
  compensation: Beta2Compensation;
}

/**
 * Mark the doc `raw_storage_failed` with the `artifact_not_linkable`
 * envelope (or generic `beta2_swap_failed` for other throws).
 *
 * Uses the raw-document-only `failClaimedUploadWithClient` — NOT
 * the paired `failClaimedUploadAndSyncArtifact`. Syncing here
 * would clobber the prior artifact's state, which is already in
 * its OWN delete lifecycle and owned by the caller that's
 * tombstoning it.
 *
 * CAS-guarded by `claim_id`: a no-op when the claim was lost,
 * which prevents a stale marker from overwriting a fresh
 * worker's state.
 *
 * Orphan recovery hint: when cleanup failed the envelope carries
 * `internal_recovery_hint: { storage_uri, storage_provider, cleanup_error }`
 * so a reconciler / ops can find the abandoned bytes.
 */
export async function markBeta2FailureOnDocument(
  args: Beta2FailureMarkerArgs,
): Promise<void> {
  const envelope: Record<string, unknown> = {
    layer: 'raw_storage',
    code: args.reasonCode,
    message: args.reasonMessage,
    occurred_at: new Date().toISOString(),
  };
  if (!args.compensation.cleanupSucceeded) {
    envelope.internal_recovery_hint = {
      storage_uri: args.stored.storageUri,
      storage_provider: args.stored.storageProvider,
      cleanup_error: args.compensation.cleanupError,
    };
  }
  try {
    await failClaimedUploadWithClient(args.pool, {
      userId: args.document.userId,
      documentId: args.document.id,
      claimId: args.claimId,
      lastError: envelope,
    });
  } catch (markerErr) {
    // eslint-disable-next-line no-console
    console.error(
      `runPhaseBeta2: failed to mark raw_storage_failed for ` +
        `document ${args.document.id} (claim ${args.claimId}); ` +
        `marker error: ${describeError(markerErr)}; original reason: ${args.reasonMessage}`,
    );
  }
}
