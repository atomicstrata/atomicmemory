/**
 * @file Step-7 storage-sibling artifact wiring for the upload pipeline.
 *
 * Extracted from `document-upload.ts` so that file stays under the
 * workspace 400-non-comment-LOC cap. Owns:
 *
 *   - `recordUploadResultAndSwapArtifact` — Phase β2 transactional
 *     helper that records the upload, soft-deletes any prior pointer
 *     artifact, and inserts a new managed artifact in
 *     `status='pending'`.
 *   - `finalizeUploadAndSyncArtifact` — paired Phase γ transaction
 *     that runs `finalizeUploadStatusWithClient` AND the artifact
 *     sync in one BEGIN..COMMIT, so the document's
 *     `raw_storage_status` and the artifact's `status` either both
 *     commit or both roll back.
 *   - `failClaimedUploadAndSyncArtifact` — paired failure tx that
 *     marks the upload row `raw_storage_failed` AND syncs the
 *     linked artifact.
 *
 * The pointer-mode provider constant `EXTERNAL_POINTER_PROVIDER`
 * lives in `../db/storage-artifact-providers.ts` (DB-layer, no
 * service-layer dependency); import it from there directly.
 */

import pg from 'pg';
import {
  failClaimedUploadWithClient,
  finalizeUploadStatusWithClient,
  recordUploadResultWithClient,
} from '../db/raw-document-blob-repository.js';
import {
  assertArtifactLinkable,
  createStorageArtifact,
  softDeleteArtifactByIdWithClient,
} from '../db/storage-artifact-repository.js';
import type { RawDocumentRow } from '../db/raw-document-types.js';
import type { StoredRawContent } from '../storage/raw-content-store.js';
import { projectArtifactProviderFields } from '../storage/provider-metadata-projection.js';
import { syncArtifactStatusFromRawDocument } from '../db/raw-doc-artifact-sync.js';

export interface RecordUploadResultInput {
  userId: string;
  documentId: string;
  claimId: string;
  storageUri: string;
  storageProvider: string;
  rawStorageMetadata: Record<string, unknown>;
}

export interface SwapToManagedInput {
  document: Pick<RawDocumentRow, 'id' | 'userId' | 'mimeType'>;
  contentHash: string;
  stored: StoredRawContent;
}

/**
 * Phase β2 atomic combo: writes the URI/provider/metadata via
 * `recordUploadResultWithClient`, soft-deletes any prior pointer
 * artifact, inserts a new managed artifact in `status='pending'`,
 * and links the document. All within a single BEGIN..COMMIT so the
 * row never sees a half-applied transition.
 *
 * Returns the new artifact id. Throws when the claim was lost (the
 * caller maps this to `UploadClaimLostError` and runs compensation).
 */
export async function recordUploadResultAndSwapArtifact(
  pool: pg.Pool,
  args: RecordUploadResultInput & SwapToManagedInput,
): Promise<{ rowCount: number; artifactId: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowCount = await recordUploadResultWithClient(client, {
      userId: args.userId,
      documentId: args.documentId,
      claimId: args.claimId,
      storageUri: args.storageUri,
      storageProvider: args.storageProvider,
      rawStorageMetadata: args.rawStorageMetadata,
    });
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return { rowCount: 0, artifactId: null };
    }
    const artifactId = await swapToManagedArtifact(client, args);
    await client.query('COMMIT');
    return { rowCount, artifactId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function swapToManagedArtifact(
  client: pg.PoolClient,
  args: SwapToManagedInput,
): Promise<string> {
  const priorLookup = await client.query<{ storage_artifact_id: string | null }>(
    `SELECT storage_artifact_id FROM raw_documents WHERE id = $1`,
    [args.document.id],
  );
  const priorArtifactId = priorLookup.rows[0]?.storage_artifact_id ?? null;
  if (priorArtifactId !== null) {
    // Refuse the swap if the prior artifact's delete lifecycle has
    // already started (`deleting` / `deleted` / `delete_failed`).
    // Otherwise the swap's own soft-delete races with the original
    // caller's claim-and-finalize flow, leaving the doc's cascade
    // attached to whichever caller wins. Throwing
    // `ArtifactNotLinkableError` here is preferable: the upload
    // caller retries after the in-flight delete completes.
    await assertArtifactLinkable(client, args.document.userId, priorArtifactId);
    await softDeleteArtifactByIdWithClient(client, args.document.userId, priorArtifactId);
  }
  const projected = projectArtifactProviderFields(
    args.stored.storageProvider,
    args.stored.providerMetadata,
  );
  const artifact = await createStorageArtifact(client, {
    userId: args.document.userId,
    provider: args.stored.storageProvider,
    mode: 'managed',
    uri: args.stored.storageUri,
    status: 'pending',
    sizeBytes: args.stored.sizeBytes,
    contentType: args.document.mimeType ?? null,
    plaintextHash: args.contentHash,
    storedHash: args.stored.contentHash,
    contentEncoding: 'identity',
    discloseContentHash: false,
    identifiers: projected.identifiers,
    providerDetails: projected.providerDetails,
    metadata: {},
  });
  await client.query(
    `UPDATE raw_documents SET storage_artifact_id = $1, updated_at = NOW()
       WHERE id = $2`,
    [artifact.id, args.document.id],
  );
  return artifact.id;
}

export interface FinalizeUploadAndSyncInput {
  userId: string;
  documentId: string;
  claimId: string;
  finalStatus: 'blob_stored' | 'blob_pending' | 'blob_available';
}

/**
 * Phase γ paired transition: flip `raw_storage_status` to the final
 * terminal state AND sync the artifact in the same transaction.
 * Returns 0 when the CAS-on-claim missed (caller maps to
 * `UploadClaimLostError`).
 */
export async function finalizeUploadAndSyncArtifact(
  pool: pg.Pool,
  args: FinalizeUploadAndSyncInput,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowCount = await finalizeUploadStatusWithClient(client, args);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.documentId,
      newRawStatus: args.finalStatus,
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

export interface FailClaimedUploadAndSyncInput {
  userId: string;
  documentId: string;
  claimId: string;
  lastError: Record<string, unknown>;
}

/**
 * Phase β failure path: mark the upload row `raw_storage_failed`
 * AND sync the artifact to `failed` in one transaction. Errors are
 * not swallowed — the caller decides whether to propagate, but the
 * marker write and the sync share the same atomicity guarantee as
 * every other paired transition in Step 7.
 */
export async function failClaimedUploadAndSyncArtifact(
  pool: pg.Pool,
  args: FailClaimedUploadAndSyncInput,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowCount = await failClaimedUploadWithClient(client, args);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    await syncArtifactStatusFromRawDocument(client, {
      rawDocumentId: args.documentId,
      newRawStatus: 'raw_storage_failed',
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
