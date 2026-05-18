/**
 * Phase-3 managed-blob helpers for the document pipeline.
 *
 * Split out of `raw-document-repository.ts` to keep that module under
 * the workspace 400-LOC cap as the managed-blob surface grew. This
 * module owns every read/update that touches the
 * `storage_mode='managed_blob'` slice of `raw_documents`:
 *
 *   - Lookups for blob URIs that need cleanup
 *     (`listManagedBlobs*`, `listOrphanedManagedBlobs*`).
 *   - The post-upload row-promotion helper
 *     (`updateRawDocumentBlobStorageWithClient`).
 *
 *   Cleanup state-machine markers used to live here as URI-keyed
 *   updates; the paired artifact-sync implementation replaced them with the id-keyed paired helpers
 *   in `db/raw-doc-artifact-sync.ts`.
 *
 * The base registry CRUD (insert / list / get / soft-delete /
 * source-site lookups) and the indexer hash setter stay in
 * `raw-document-repository.ts` so this module can stay tightly
 * scoped to the managed-blob lifecycle.
 *
 * No row-mapping helpers are needed here — every function returns
 * `(storage_provider, storage_uri)` tuples or executes UPDATEs, so
 * the snake_case → camelCase mapping the registry CRUD needs lives
 * with the registry helpers, not here.
 */

import pg from 'pg';

/** Shape returned by every managed-blob lookup in this module.
 * `rawDocumentId` lets the cleanup loop sync the linked
 * `storage_artifacts` row by id — URIs are not globally unique
 * across documents, so id-keyed sync removes the ambiguity.
 * `rawStorageMetadata` carries the provider-specific sidecar so
 * `cleanupManagedBlobs` can pass it as opaque hints to
 * `RawContentStore.delete` (e.g. the Filecoin adapter uses
 * `filecoin.copies[].piece_id` + `data_set_id` to delete a
 * freshly-uploaded piece without relying on the SDK's
 * CID→active-piece lookup). Non-Filecoin adapters ignore it. */
export interface ManagedBlobRefRow {
  rawDocumentId: string;
  storageProvider: string;
  storageUri: string;
  rawStorageMetadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cleanup-target lookups (active blobs for live cascades).
// ---------------------------------------------------------------------------

/**
 * `(storage_provider, storage_uri)` tuples for the *active* managed-blob
 * row of a single document. Caller hands the result to
 * `cleanupManagedBlobs()` *after* the DB transaction commits. Active-only
 * (deleted_at IS NULL) — soft-deleted rows are skipped to avoid
 * double-deleting blobs after a prior cascade.
 */
export async function listManagedBlobsForDocumentWithClient(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  documentId: string,
): Promise<ManagedBlobRefRow[]> {
  const result = await client.query(
    `SELECT id, storage_provider, storage_uri, raw_storage_metadata
       FROM raw_documents
      WHERE id = $1
        AND user_id = $2
        AND storage_mode = 'managed_blob'
        AND storage_uri IS NOT NULL
        AND storage_provider IS NOT NULL
        AND deleted_at IS NULL`,
    [documentId, userId],
  );
  return result.rows.map(toManagedBlobRef);
}

/**
 * Source-scoped sibling of `listManagedBlobsForDocumentWithClient`.
 * Used by `deleteBySource` so source-reset can hand a complete blob
 * list to the post-commit cleanup pass.
 */
export async function listManagedBlobsBySourceWithClient(
  client: pg.PoolClient,
  userId: string,
  sourceSite: string,
): Promise<ManagedBlobRefRow[]> {
  const result = await client.query(
    `SELECT d.id, d.storage_provider, d.storage_uri, d.raw_storage_metadata
       FROM raw_documents d
       JOIN raw_sources s ON s.id = d.raw_source_id
      WHERE d.user_id = $1
        AND s.source_site = $2
        AND d.storage_mode = 'managed_blob'
        AND d.storage_uri IS NOT NULL
        AND d.storage_provider IS NOT NULL
        AND d.deleted_at IS NULL`,
    [userId, sourceSite],
  );
  return result.rows.map(toManagedBlobRef);
}

/**
 * Active managed-blob URIs for a user (`userId` set) or globally
 * (`userId` undefined). Used by `deleteAll`'s pre-hard-delete cleanup
 * hook so the wipe can flush the blob store before dropping the rows.
 */
export async function listManagedBlobsForUser(
  pool: pg.Pool,
  userId?: string,
): Promise<ManagedBlobRefRow[]> {
  const where = userId === undefined ? 'WHERE' : 'WHERE user_id = $1 AND';
  const params = userId === undefined ? [] : [userId];
  const result = await pool.query(
    `SELECT id, storage_provider, storage_uri, raw_storage_metadata
       FROM raw_documents
      ${where}
            storage_mode = 'managed_blob'
        AND storage_uri IS NOT NULL
        AND storage_provider IS NOT NULL
        AND deleted_at IS NULL`,
    params,
  );
  return result.rows.map(toManagedBlobRef);
}

// ---------------------------------------------------------------------------
// Retry-target lookups (orphan blobs left by a previously-failed cleanup).
// ---------------------------------------------------------------------------

/**
 * Retry-safe lookup: managed-blob URIs that need cleanup *for a
 * soft-deleted document* whose prior cleanup pass failed. Consulted by
 * a retry of `DELETE /v1/documents/:id` so it can re-attempt
 * `store.delete()` on the orphan instead of returning
 * `already_deleted=true` while the blob is still present.
 *
 * Filters: `deleted_at IS NOT NULL` (only soft-deleted rows), and
 * `raw_storage_status = 'raw_storage_failed'` (only the rows whose
 * cleanup failed — `blob_deleted` rows are already clean).
 */
export async function listOrphanedManagedBlobsForDocument(
  pool: pg.Pool,
  userId: string,
  documentId: string,
): Promise<ManagedBlobRefRow[]> {
  const result = await pool.query(
    `SELECT id, storage_provider, storage_uri, raw_storage_metadata
       FROM raw_documents
      WHERE id = $1
        AND user_id = $2
        AND storage_mode = 'managed_blob'
        AND storage_uri IS NOT NULL
        AND storage_provider IS NOT NULL
        AND deleted_at IS NOT NULL
        AND raw_storage_status = 'raw_storage_failed'`,
    [documentId, userId],
  );
  return result.rows.map(toManagedBlobRef);
}

/**
 * Source-scoped sibling of `listOrphanedManagedBlobsForDocument`. Used
 * by the retry path of `POST /v1/memories/reset-source` so a second
 * reset-by-source after a partially-failed cleanup can still find the
 * orphan blobs to retry on.
 */
export async function listOrphanedManagedBlobsBySource(
  pool: pg.Pool,
  userId: string,
  sourceSite: string,
): Promise<ManagedBlobRefRow[]> {
  const result = await pool.query(
    `SELECT d.id, d.storage_provider, d.storage_uri, d.raw_storage_metadata
       FROM raw_documents d
       JOIN raw_sources s ON s.id = d.raw_source_id
      WHERE d.user_id = $1
        AND s.source_site = $2
        AND d.storage_mode = 'managed_blob'
        AND d.storage_uri IS NOT NULL
        AND d.storage_provider IS NOT NULL
        AND d.deleted_at IS NOT NULL
        AND d.raw_storage_status = 'raw_storage_failed'`,
    [userId, sourceSite],
  );
  return result.rows.map(toManagedBlobRef);
}

// the paired artifact-sync implementation superseded the URI-keyed cleanup markers
// (`markRawStorageDeletedByUri`, `markRawStorageTombstonedByUri`,
// `markRawStorageFailedByUri`) with the id-keyed paired helpers in
// `db/raw-doc-artifact-sync.ts`. The id-keyed form is unambiguous
// when multiple documents share a `storage_uri`.

// the paired artifact-sync implementation superseded `markCleanupSuccess` with
// `markCleanupSuccessAndSyncArtifact` in `db/raw-doc-artifact-sync.ts`,
// which pairs the marker write with the artifact sync in one
// transaction.

// ---------------------------------------------------------------------------
// the managed-upload upload-pipeline α/β/β2/γ helpers.
// ---------------------------------------------------------------------------

/**
 * the claim step: short-tx slot claim. Writes `raw_storage_status =
 * 'blob_uploading'` + claim_id + claimed_at + plaintext content_hash +
 * plaintext size_bytes.
 *
 * `clearDurableUri` (rev-fix HIGH 2) selects between the two
 * recovery paths:
 *   - `true` (reclaimAndUpload): the row may carry a stale URI /
 *     provider / metadata from a prior failed attempt — clear them
 *     so a crash before the durable URI-write step cannot leave a finalize-recovery
 *     window pointing at the old bytes. `raw_storage_pending_since`
 *     is cleared too (the row is leaving the pending state).
 *   - `false` (finalize-recovery): preserve `storage_uri`,
 *     `storage_provider`, and `raw_storage_metadata`. the finalization step alone
 *     promotes the row; β + β2 are skipped because the bytes are
 *     already durable on the provider.
 */
export async function claimUploadSlotWithClient(
  client: pg.PoolClient,
  args: {
    userId: string;
    documentId: string;
    claimId: string;
    contentHash: string;
    sizeBytes: number;
    clearDurableUri: boolean;
  },
): Promise<number> {
  if (args.clearDurableUri) {
    const result = await client.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'blob_uploading',
              raw_storage_claim_id = $1,
              raw_storage_claimed_at = NOW(),
              content_hash = $2,
              size_bytes = $3,
              storage_uri = NULL,
              storage_provider = NULL,
              raw_storage_metadata = '{}'::jsonb,
              raw_storage_pending_since = NULL,
              updated_at = NOW()
        WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL`,
      [args.claimId, args.contentHash, args.sizeBytes, args.documentId, args.userId],
    );
    return result.rowCount ?? 0;
  }
  const result = await client.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'blob_uploading',
            raw_storage_claim_id = $1,
            raw_storage_claimed_at = NOW(),
            content_hash = $2,
            size_bytes = $3,
            updated_at = NOW()
      WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL`,
    [args.claimId, args.contentHash, args.sizeBytes, args.documentId, args.userId],
  );
  return result.rowCount ?? 0;
}

/**
 * the durable URI-write step: short-tx durable URI record. Writes storage_mode,
 * storage_uri, storage_provider, raw_storage_metadata. Status STAYS
 * `blob_uploading` — the finalization step flips it. Guarded by claim_id so a
 * stale claim's β2 cannot clobber a row another worker has since
 * reclaimed. Returns rowCount; caller compensates with a delete on 0.
 */
export async function recordUploadResultWithClient(
  client: pg.PoolClient | pg.Pool,
  args: {
    userId: string;
    documentId: string;
    claimId: string;
    storageUri: string;
    storageProvider: string;
    rawStorageMetadata: Record<string, unknown>;
  },
): Promise<number> {
  const result = await client.query(
    `UPDATE raw_documents
        SET storage_mode = 'managed_blob',
            storage_uri = $1,
            storage_provider = $2,
            raw_storage_metadata = $3::jsonb,
            updated_at = NOW()
      WHERE id = $4 AND user_id = $5
        AND raw_storage_status = 'blob_uploading'
        AND raw_storage_claim_id = $6
        AND deleted_at IS NULL`,
    [
      args.storageUri,
      args.storageProvider,
      JSON.stringify(args.rawStorageMetadata),
      args.documentId,
      args.userId,
      args.claimId,
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * the finalization step: compare-and-set status flip. Writes the final
 * raw_storage_status, sets pending_since when entering blob_pending,
 * clears the claim, and layer-scopes the last_error clear (drops
 * raw_storage envelopes only). Guarded on claim_id + storage_uri NOT
 * NULL. Returns rowCount.
 */
export async function finalizeUploadStatusWithClient(
  client: pg.PoolClient | pg.Pool,
  args: {
    userId: string;
    documentId: string;
    claimId: string;
    finalStatus: 'blob_stored' | 'blob_pending' | 'blob_available';
  },
): Promise<number> {
  const result = await client.query(
    `UPDATE raw_documents
        SET raw_storage_status = $1,
            raw_storage_claim_id = NULL,
            raw_storage_claimed_at = NULL,
            raw_storage_pending_since = CASE
              WHEN $1 = 'blob_pending' THEN NOW()
              ELSE NULL
            END,
            last_error = CASE
              WHEN last_error IS NOT NULL AND last_error->>'layer' = 'raw_storage'
              THEN NULL
              ELSE last_error
            END,
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3
        AND raw_storage_status = 'blob_uploading'
        AND raw_storage_claim_id = $4
        AND storage_uri IS NOT NULL
        AND deleted_at IS NULL`,
    [args.finalStatus, args.documentId, args.userId, args.claimId],
  );
  return result.rowCount ?? 0;
}

/**
 * the provider-write step failure-path: clear an active claim and flip the row to
 * raw_storage_failed with a sanitized last_error envelope. Guarded
 * by claim_id so a stale claim's failure marker cannot overwrite a
 * subsequent successful retry. Returns rowCount.
 */
export async function failClaimedUploadWithClient(
  client: pg.PoolClient | pg.Pool,
  args: {
    userId: string;
    documentId: string;
    claimId: string;
    lastError: Record<string, unknown>;
  },
): Promise<number> {
  const result = await client.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'raw_storage_failed',
            raw_storage_claim_id = NULL,
            raw_storage_claimed_at = NULL,
            last_error = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND raw_storage_claim_id = $4`,
    [JSON.stringify(args.lastError), args.documentId, args.userId, args.claimId],
  );
  return result.rowCount ?? 0;
}

/**
 * Cleanup-failure marker. Called from a soft-delete cascade after the
 * DB transaction has committed when the post-commit blob delete
 * raised: flips `raw_storage_status` to `raw_storage_failed` on the
 * row backing `storageUri`. The row is *already* soft-deleted
 * (deleted_at set), so the explicit `WHERE deleted_at IS NOT NULL`
 * guards against accidentally clobbering an active row.
 *
 * Intentionally scoped by `storage_uri` (and user) rather than `id` so
 * an orphaned blob can't be associated with the wrong tombstoned doc
 * in case of duplicate URIs (defensive — adapter URIs are unique).
 */
// the paired artifact-sync implementation superseded `markRawStorageFailedByUri` with the id-keyed
// paired helper `markCleanupFailedAndSyncArtifact` in
// `db/raw-doc-artifact-sync.ts`; the URI-keyed form is gone.

// the managed-upload superseded the legacy single-shot
// `updateRawDocumentBlobStorageWithClient` helper. The upload service
// now drives the row's promotion through the α/β/β2/γ helpers above:
// `claimUploadSlotWithClient` (the claim step) writes plaintext hash + size +
// claim_id with status='blob_uploading';
// `recordUploadResultWithClient` (the durable URI-write step) records URI/provider/
// metadata while status stays 'blob_uploading';
// `finalizeUploadStatusWithClient` (the finalization step) flips to the final
// terminal status and clears the claim. The legacy helper would have
// fought the new split — removed cleanly rather than left as a
// dead-code attractor.

// ---------------------------------------------------------------------------
// Internal mappers
// ---------------------------------------------------------------------------

function toManagedBlobRef(row: {
  id: string;
  storage_provider: string;
  storage_uri: string;
  raw_storage_metadata: unknown;
}): ManagedBlobRefRow {
  // `raw_storage_metadata` is a `jsonb` column; pg returns it as
  // a parsed object (or `null` on a row that never set it). The
  // cleanup loop passes this straight through to
  // `RawContentStore.delete` as opaque hints — the adapter is
  // responsible for narrowing/validating its own provider sibling.
  const metadata = row.raw_storage_metadata;
  const rawStorageMetadata =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  return {
    rawDocumentId: row.id,
    storageProvider: row.storage_provider,
    storageUri: row.storage_uri,
    rawStorageMetadata,
  };
}
