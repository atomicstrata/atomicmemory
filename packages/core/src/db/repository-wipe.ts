/**
 * @file Full-wipe path for the deleteAll (user-scoped + global)
 * cleanup-then-hard-delete sequence.
 *
 * Extracted from `repository-write.ts` to keep that module under
 * the workspace's 400-non-comment-LOC cap. The wipe path is its own
 * concern: it cleans managed blobs first (so a failure can mark
 * surviving rows `raw_storage_failed` + sync the linked artifact)
 * and then hard-deletes memory tables, derived user projections,
 * raw_documents, storage_artifacts, and raw_sources in FK-safe order.
 */

import type pg from 'pg';
import {
  cleanupManagedBlobs,
  ManagedBlobCleanupError,
} from '../storage/cleanup.js';
import { singleStoreRegistry } from '../storage/store-registry.js';
import type { RawContentStore } from '../storage/raw-content-store.js';
import type { RawContentStoreRegistry } from '../storage/store-registry.js';
import { listManagedBlobsForUser } from './raw-document-blob-repository.js';
import {
  buildRawStorageCleanupFailureEnvelope,
  markCleanupFailedAndSyncArtifact,
} from './raw-doc-artifact-sync.js';

const USER_SCOPED_WIPE_TABLES_BEFORE_MEMORIES = [
  'memory_contradictions',
  'memory_conflicts',
  'belief_edges',
  'session_reflections',
  'reflection_jobs',
  'entity_cards',
  'entity_values',
  'entity_attributes',
  'user_profiles',
  'recaps',
  'session_summaries',
  'conv_summaries',
  'lessons',
  'agent_trust',
  'first_mention_events',
  'temporal_linkage_list',
  'entity_relations',
  'memory_atomic_facts',
  'memory_foresight',
  'canonical_memory_objects',
  'observation_dirty',
] as const;

export interface DeleteAllOptions {
  rawContentStore?: RawContentStore | null;
  /**
   * Phase 4a per-row dispatch registry. Defaults to a single-store
   * registry wrapping `rawContentStore` so existing callers that
   * pass just the active store continue to work; composition-root
   * code passes a multi-provider registry when
   * `RAW_STORAGE_LEGACY_PROVIDERS` is set.
   */
  storeRegistry?: RawContentStoreRegistry;
}

/**
 * Hard-wipe everything for a user (`userId` set) or globally
 * (`userId` undefined). Cleanup runs first; on failure the surviving
 * rows are marked `raw_storage_failed` (with the linked artifact
 * synced via the paired helper) and `ManagedBlobCleanupError` is
 * thrown without touching the rest of the tables — the operator
 * fixes the upstream issue and retries.
 */
export async function deleteAll(
  pool: pg.Pool,
  userId?: string,
  options: DeleteAllOptions = {},
): Promise<void> {
  const blobs = await listManagedBlobsForUser(pool, userId);
  if (blobs.length > 0) {
    const registry = options.storeRegistry
      ?? singleStoreRegistry(options.rawContentStore ?? null);
    const result = await cleanupManagedBlobs(registry, blobs);
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        await markDeleteAllCleanupFailure(
          pool,
          userId,
          failure.rawDocumentId,
          buildRawStorageCleanupFailureEnvelope(failure.message, failure.storageProvider),
        );
      }
      throw new ManagedBlobCleanupError(result);
    }
  }
  if (userId) await deleteAllForUser(pool, userId);
  else await deleteAllGlobal(pool);
}

/**
 * Mark a cleanup-failure row `raw_storage_failed` and sync the
 * linked artifact to `failed`. For `userId` set (user-scoped wipe),
 * we use the standard paired helper. For the global wipe path
 * (`userId` undefined), we resolve the row's owner first so the
 * paired helper can run with its owner-scope guard intact.
 */
async function markDeleteAllCleanupFailure(
  pool: pg.Pool,
  userId: string | undefined,
  rawDocumentId: string,
  lastError: Record<string, unknown>,
): Promise<void> {
  if (userId !== undefined) {
    await markCleanupFailedAndSyncArtifact(pool, { userId, rawDocumentId, lastError });
    return;
  }
  const lookup = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM raw_documents WHERE id = $1`,
    [rawDocumentId],
  );
  if (lookup.rowCount === 0) return;
  await markCleanupFailedAndSyncArtifact(pool, {
    userId: lookup.rows[0].user_id,
    rawDocumentId,
    lastError,
  });
}

/**
 * User-scoped hard-delete. Derived memory projections are deleted
 * before base memories; documents are deleted before storage_artifacts
 * because the composite FK
 * `raw_documents(storage_artifact_id, user_id) → storage_artifacts`
 * points from documents to artifacts.
 */
async function deleteAllForUser(pool: pg.Pool, userId: string): Promise<void> {
  await deleteUserScopedTables(pool, userId, USER_SCOPED_WIPE_TABLES_BEFORE_MEMORIES);
  await pool.query('DELETE FROM memory_visibility_grants WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM memory_entities WHERE memory_id IN (SELECT id FROM memories WHERE user_id = $1) OR entity_id IN (SELECT id FROM entities WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM memory_evidence WHERE claim_version_id IN (SELECT id FROM memory_claim_versions WHERE user_id = $1) OR memory_id IN (SELECT id FROM memories WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM memory_claim_versions WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM memory_claims WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM memory_links WHERE source_id IN (SELECT id FROM memories WHERE user_id = $1) OR target_id IN (SELECT id FROM memories WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM memories WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM entities WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM episodes WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM document_chunks WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM raw_documents WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM storage_artifacts WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM raw_sources WHERE user_id = $1', [userId]);
}

/** Global hard-delete. Same FK-safe order; no user filter. */
async function deleteAllGlobal(pool: pg.Pool): Promise<void> {
  await deleteGlobalTables(pool, USER_SCOPED_WIPE_TABLES_BEFORE_MEMORIES);
  await pool.query('DELETE FROM memory_visibility_grants');
  await pool.query('DELETE FROM memory_entities');
  await pool.query('DELETE FROM memory_evidence');
  await pool.query('DELETE FROM memory_claim_versions');
  await pool.query('DELETE FROM memory_claims');
  await pool.query('DELETE FROM memory_links');
  await pool.query('DELETE FROM memories');
  await pool.query('DELETE FROM entities');
  await pool.query('DELETE FROM episodes');
  await pool.query('DELETE FROM document_chunks');
  await pool.query('DELETE FROM raw_documents');
  await pool.query('DELETE FROM storage_artifacts');
  await pool.query('DELETE FROM raw_sources');
}

async function deleteUserScopedTables(
  pool: pg.Pool,
  userId: string,
  tableNames: readonly string[],
): Promise<void> {
  for (const tableName of tableNames) {
    await pool.query(`DELETE FROM ${tableName} WHERE user_id = $1`, [userId]);
  }
}

async function deleteGlobalTables(pool: pg.Pool, tableNames: readonly string[]): Promise<void> {
  for (const tableName of tableNames) {
    await pool.query(`DELETE FROM ${tableName}`);
  }
}
