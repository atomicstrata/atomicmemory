/**
 * @file Document-scoped delete cascades.
 *
 * Owns `softDeleteDocumentCascade` (single-document) and
 * `deleteBySource` (source-reset), plus the Step-7 helpers that
 * soft-delete linked `storage_artifacts` rows in the same
 * transaction. Extracted from `repository-write.ts` to keep that
 * module under the workspace 400-non-comment-LOC cap.
 */

import type pg from 'pg';
import {
  deleteDocumentsBySourceWithClient,
  softDeleteRawDocument,
} from './raw-document-repository.js';
import { deleteChunksBySourceWithClient, softDeleteChunksForDocument } from './document-chunk-repository.js';
import {
  listManagedBlobsBySourceWithClient,
  listManagedBlobsForDocumentWithClient,
  type ManagedBlobRefRow,
} from './raw-document-blob-repository.js';
import { softDeleteMemoriesForDocument } from './repository-write.js';

export interface SoftDeleteDocumentCascadeResult {
  removed: boolean;
  memoriesDeleted: number;
  chunksDeleted: number;
  /**
   * Managed-blob refs (with `rawDocumentId`) the caller should hand
   * to `cleanupManagedBlobs()` after the transaction commits. Empty
   * when the document was pointer-only or already deleted.
   */
  blobs: ManagedBlobRefRow[];
}

/**
 * Soft-delete a document together with the chunks + provenance-linked
 * memories materialized from it (Phase 2). Runs in one transaction
 * with a per-document advisory lock so a concurrent index call
 * serializes cleanly. Idempotent: returns `{ removed: false }` when
 * the document was already missing/deleted/owned by a different user.
 *
 * Step 7 — when the document has no managed blob to clean up
 * (pointer-only, or already-terminal managed), the linked
 * `storage_artifacts` row is soft-deleted in the same transaction.
 * The cleanup path handles the managed case via the paired
 * `markCleanupSuccessAndSyncArtifact` helper.
 */
export async function softDeleteDocumentCascade(
  pool: pg.Pool,
  userId: string,
  documentId: string,
): Promise<SoftDeleteDocumentCascadeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
    const blobs = await listManagedBlobsForDocumentWithClient(client, userId, documentId);
    const memoriesDeleted = await softDeleteMemoriesForDocument(client, userId, documentId);
    const chunksDeleted = await softDeleteChunksForDocument(client, userId, documentId);
    const removed = await softDeleteRawDocument(client, userId, documentId);
    if (removed && blobs.length === 0) {
      await softDeleteLinkedArtifactForDocumentWithClient(client, userId, documentId);
    }
    await client.query('COMMIT');
    return { removed, memoriesDeleted, chunksDeleted, blobs: removed ? blobs : [] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Soft-delete the `storage_artifacts` row linked to a document
 * inside an open transaction. No-op when the document has no link.
 * Owner-scoped on the document side; the artifact's composite FK
 * to `(id, user_id)` already prevents cross-user pairings.
 *
 * Skips rows whose delete lifecycle has already started
 * (`status IN ('deleting', 'deleted', 'delete_failed')`). After the
 * Commit D reorder, `StorageService.deleteArtifact` claims the
 * artifact BEFORE cascading documents — so when this helper runs
 * during a `policy=with_documents` cascade, the artifact is
 * already at `status='deleting'` and the storage service's own
 * finalize step owns the terminal transition. Clobbering the
 * status here would race the finalize CAS and surface
 * `markDeleteSuccess: no matching claim`.
 */
async function softDeleteLinkedArtifactForDocumentWithClient(
  client: pg.PoolClient,
  userId: string,
  documentId: string,
): Promise<void> {
  await client.query(
    `UPDATE storage_artifacts sa
       SET status = 'deleted',
           deleted_at = COALESCE(sa.deleted_at, NOW()),
           delete_attempt_id = NULL,
           updated_at = NOW()
      FROM raw_documents rd
      WHERE rd.id = $1
        AND rd.user_id = $2
        AND rd.storage_artifact_id = sa.id
        AND sa.status NOT IN ('deleting', 'deleted', 'delete_failed')`,
    [documentId, userId],
  );
}

/**
 * Source-reset variant — soft-deletes any pointer (or already-
 * clean managed) artifact linked to a document under the given
 * source. Managed-blob rows that still need cleanup are left to
 * the post-commit cleanup path.
 *
 * Skips rows whose delete lifecycle has already started
 * (`status IN ('deleting', 'deleted', 'delete_failed')`). Without
 * this guard a source reset racing `StorageService.deleteArtifact`
 * could clobber the artifact's claimed `delete_attempt_id`, causing
 * the storage service's finalize CAS to miss after `backend.delete`
 * runs. Mirrors the same guard on
 * `softDeleteLinkedArtifactForDocumentWithClient`.
 */
async function softDeleteLinkedArtifactsForSourceWithClient(
  client: pg.PoolClient,
  userId: string,
  sourceSite: string,
): Promise<void> {
  await client.query(
    `UPDATE storage_artifacts sa
       SET status = 'deleted',
           deleted_at = COALESCE(sa.deleted_at, NOW()),
           delete_attempt_id = NULL,
           updated_at = NOW()
      FROM raw_documents rd
      JOIN raw_sources rs ON rs.id = rd.raw_source_id
     WHERE rs.user_id = $1
       AND rs.source_site = $2
       AND rd.user_id = $1
       AND rd.storage_artifact_id = sa.id
       AND sa.status NOT IN ('deleting', 'deleted', 'delete_failed')
       AND (rd.storage_uri IS NULL OR rd.raw_storage_status IN ('blob_deleted', 'blob_tombstoned'))`,
    [userId, sourceSite],
  );
}

export interface DeleteBySourceResult {
  deletedMemories: number;
  deletedEpisodes: number;
  deletedDocuments: number;
  /** Managed-blob refs the caller hands to `cleanupManagedBlobs()`. */
  blobs: ManagedBlobRefRow[];
}

/**
 * Delete all data for a given user + source_site combination.
 * Hard-deletes across memory-side tables and soft-deletes
 * (tombstones) matching `raw_documents` in safe referential order
 * within a single transaction. Step 7 — soft-deletes the linked
 * `storage_artifacts` rows for pointer-only / terminal-managed
 * docs in the same transaction, so a source reset cannot leave
 * orphan active artifact links.
 */
export async function deleteBySource(
  pool: pg.Pool,
  userId: string,
  sourceSite: string,
): Promise<DeleteBySourceResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM memory_evidence
       WHERE claim_version_id IN (
         SELECT id FROM memory_claim_versions WHERE user_id = $1 AND source_site = $2
       )`,
      [userId, sourceSite],
    );
    await client.query(
      `DELETE FROM memory_claim_versions WHERE user_id = $1 AND source_site = $2`,
      [userId, sourceSite],
    );
    await client.query(
      `DELETE FROM memory_claims
       WHERE user_id = $1
         AND id NOT IN (SELECT claim_id FROM memory_claim_versions WHERE user_id = $1)`,
      [userId],
    );
    await client.query(
      `DELETE FROM memory_links
       WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)
          OR target_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );
    await client.query(
      `DELETE FROM memory_entities
       WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );
    await client.query(
      `DELETE FROM memory_atomic_facts WHERE user_id = $1 AND source_site = $2
       AND parent_memory_id IN (SELECT id FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL)`,
      [userId, sourceSite],
    );
    const memResult = await client.query(
      `DELETE FROM memories WHERE user_id = $1 AND source_site = $2 AND workspace_id IS NULL RETURNING id`,
      [userId, sourceSite],
    );
    const epResult = await client.query(
      `DELETE FROM episodes WHERE user_id = $1 AND source_site = $2 RETURNING id`,
      [userId, sourceSite],
    );
    const blobs = await listManagedBlobsBySourceWithClient(client, userId, sourceSite);
    await deleteChunksBySourceWithClient(client, userId, sourceSite);
    const deletedDocuments = await deleteDocumentsBySourceWithClient(client, userId, sourceSite);
    await softDeleteLinkedArtifactsForSourceWithClient(client, userId, sourceSite);
    await client.query('COMMIT');
    return {
      deletedMemories: memResult.rowCount ?? 0,
      deletedEpisodes: epResult.rowCount ?? 0,
      deletedDocuments,
      blobs,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
