/**
 * CRUD operations and auxiliary methods extracted from MemoryService.
 * Covers list, get, delete, stats, consolidation, decay, audit, lessons, and backfill.
 */

import { config } from '../config.js';
import { type ClaimSlotInput } from '../db/claim-repository.js';
import { findConsolidationCandidates, executeConsolidation, type ConsolidationResult, type ConsolidationExecutionResult } from './consolidation-service.js';
import { evaluateDecayCandidates, checkMemoryCap, type DecayResult, type CapCheckResult } from './memory-lifecycle.js';
import { emitAuditEvent } from './audit-events.js';
import { shouldDeferAudn, deferMemoryForReconciliation, reconcileUser, reconcileAll, getReconciliationStatus, type ReconciliationResult } from './deferred-audn.js';
import { buildPersistedRelationClaimSlot } from './claim-slotting.js';
import type { AuditTrailEntry, MutationSummary } from '../db/repository-types.js';
import type { MemoryServiceDeps } from './memory-service-types.js';
import { cleanupManagedBlobs, ManagedBlobCleanupError } from '../storage/cleanup.js';
import { singleStoreRegistry } from '../storage/store-registry.js';
import {
  listOrphanedManagedBlobsBySource,
} from '../db/raw-document-blob-repository.js';
import {
  markCleanupFailedAndSyncArtifact,
  markCleanupSuccessAndSyncArtifact,
} from '../db/raw-doc-artifact-sync.js';

export interface ClaimSlotBackfillResult {
  scanned: number;
  updated: number;
}

export async function listMemories(deps: MemoryServiceDeps, userId: string, limit: number = 20, offset: number = 0, sourceSite?: string, episodeId?: string, sessionId?: string) {
  return deps.stores.memory.listMemories(userId, limit, offset, sourceSite, episodeId, sessionId);
}

export async function listMemoriesInWorkspace(deps: MemoryServiceDeps, workspaceId: string, limit: number = 20, offset: number = 0, callerAgentId: string, sessionId?: string) {
  return deps.stores.memory.listMemoriesInWorkspace(workspaceId, limit, offset, callerAgentId, sessionId);
}

export async function getMemory(deps: MemoryServiceDeps, id: string, userId: string) {
  return deps.stores.memory.getMemory(id, userId);
}

export async function getMemoryInWorkspace(deps: MemoryServiceDeps, id: string, workspaceId: string, callerAgentId: string) {
  return deps.stores.memory.getMemoryInWorkspace(id, workspaceId, callerAgentId);
}

/** Workspace delete enforces visibility: returns false if caller can't see the memory. */
export async function deleteMemoryInWorkspace(deps: MemoryServiceDeps, id: string, workspaceId: string, callerAgentId: string): Promise<boolean> {
  const memory = await deps.stores.memory.getMemoryInWorkspace(id, workspaceId, callerAgentId);
  if (!memory) return false;
  await deps.stores.memory.softDeleteMemoryInWorkspace(id, workspaceId);
  if (config.auditLoggingEnabled) {
    emitAuditEvent('memory:delete', '', {}, { memoryId: id, workspaceId });
  }
  return true;
}

/** Expand staged summaries to full content for on-demand loading. */
export async function expandMemories(deps: MemoryServiceDeps, userId: string, memoryIds: string[]): Promise<Array<{ id: string; content: string }>> {
  const fetched = await Promise.all(memoryIds.map((id) => deps.stores.memory.getMemory(id, userId)));
  return fetched.filter(Boolean).map((m) => ({ id: m!.id, content: m!.content }));
}

export async function expandMemoriesInWorkspace(
  deps: MemoryServiceDeps,
  workspaceId: string,
  memoryIds: string[],
  callerAgentId: string,
): Promise<Array<{ id: string; content: string }>> {
  const fetched = await Promise.all(
    memoryIds.map((id) => deps.stores.memory.getMemoryInWorkspace(id, workspaceId, callerAgentId)),
  );
  return fetched.filter(Boolean).map((m) => ({ id: m!.id, content: m!.content }));
}

export async function deleteMemory(deps: MemoryServiceDeps, id: string, userId: string) {
  const version = await deps.stores.claim.getClaimVersionByMemoryId(userId, id);
  const target = version ? { claimId: version.claim_id, versionId: version.id } : null;
  await deps.stores.memory.softDeleteMemory(userId, id);
  if (config.auditLoggingEnabled) {
    emitAuditEvent('memory:delete', userId, {}, { memoryId: id });
  }
  if (!target) return;
  await deps.stores.claim.supersedeClaimVersion(userId, target.versionId, null);
  await deps.stores.claim.invalidateClaim(userId, target.claimId);
}

/**
 * Delete all memories, episodes, claims, and related data for a user + source_site,
 * and tombstone (soft-delete) every `raw_documents` row registered against the
 * same source. Surgical reset scoped to a single source -- does NOT wipe the whole user.
 */
export async function resetBySource(deps: MemoryServiceDeps, userId: string, sourceSite: string): Promise<{ deletedMemories: number; deletedEpisodes: number; deletedDocuments: number }> {
  const result = await deps.stores.memory.deleteBySource(userId, sourceSite);
  // Cleanup target: blobs the cascade just tombstoned, OR — when the
  // cascade found nothing fresh to soft-delete (typical retry path) —
  // the orphan blobs left behind by a previously-failed cleanup pass
  // for this source. Without this lookup, a retry of source reset
  // could see zero active rows, skip cleanup, and report success
  // while bytes were still on disk.
  const blobsToClean = result.blobs.length > 0
    ? result.blobs
    : await listOrphanedManagedBlobsBySource(deps.stores.pool, userId, sourceSite);
  if (blobsToClean.length > 0) {
    const registry = deps.storeRegistry ?? singleStoreRegistry(deps.rawContentStore ?? null);
    const cleanup = await cleanupManagedBlobs(registry, blobsToClean);
    // Mark partial successes terminal *before* throwing. A mixed-result
    // cleanup that doesn't record the wins would leak retry work onto
    // rows that are already clean. The marker is chosen by the
    // adapter's `semantics` field — `'deleted'` → `blob_deleted`,
    // `'unpinned'`/`'tombstoned'` → `blob_tombstoned` (Phase 4a §1).
    for (const success of cleanup.successes) {
      await markCleanupSuccessAndSyncArtifact(deps.stores.pool, {
        userId,
        rawDocumentId: success.rawDocumentId,
        storageUri: success.storageUri,
        semantics: success.semantics,
      });
    }
    if (cleanup.failures.length > 0) {
      for (const failure of cleanup.failures) {
        await markCleanupFailedAndSyncArtifact(deps.stores.pool, {
          userId,
          rawDocumentId: failure.rawDocumentId,
        });
      }
      throw new ManagedBlobCleanupError(cleanup);
    }
  }
  if (config.auditLoggingEnabled) {
    emitAuditEvent('memory:reset-source', userId, {
      sourceSite,
      deletedMemories: result.deletedMemories,
      deletedEpisodes: result.deletedEpisodes,
      deletedDocuments: result.deletedDocuments,
    });
  }
  return {
    deletedMemories: result.deletedMemories,
    deletedEpisodes: result.deletedEpisodes,
    deletedDocuments: result.deletedDocuments,
  };
}

export async function getStats(deps: MemoryServiceDeps, userId: string) {
  return deps.stores.memory.getMemoryStats(userId);
}

/** Identify memory clusters that are candidates for consolidation. */
export async function consolidate(deps: MemoryServiceDeps, userId: string): Promise<ConsolidationResult> {
  return findConsolidationCandidates(deps.stores.memory, userId);
}

/** Execute consolidation: synthesize clusters via LLM and archive originals. */
export async function performExecuteConsolidation(deps: MemoryServiceDeps, userId: string): Promise<ConsolidationExecutionResult> {
  return executeConsolidation(deps.stores.memory, deps.stores.claim, userId, undefined, deps.config);
}

/** Run deferred AUDN reconciliation for a user (background pass). */
export async function reconcileDeferred(deps: MemoryServiceDeps, userId: string): Promise<ReconciliationResult> {
  return reconcileUser(deps.stores.pool, deps.stores.memory, userId);
}

/** Run deferred AUDN reconciliation across all users (batch job). */
export async function reconcileDeferredAll(deps: MemoryServiceDeps): Promise<ReconciliationResult> {
  return reconcileAll(deps.stores.pool, deps.stores.memory);
}

/** Get deferred AUDN reconciliation status for a user. */
export async function getDeferredStatus(deps: MemoryServiceDeps, userId: string) {
  return getReconciliationStatus(deps.stores.pool, userId);
}

/** Evaluate memories for decay and return archival candidates. */
export async function evaluateDecay(deps: MemoryServiceDeps, userId: string, referenceTime?: Date): Promise<DecayResult> {
  const memories = await deps.stores.memory.listMemories(userId, 500, 0);
  const decayConfig = {
    retentionThreshold: config.decayRetentionThreshold,
    importanceWeight: 0.4, recencyWeight: 0.4, accessWeight: 0.2,
    minAgeMs: config.decayMinAgeDays * 24 * 60 * 60 * 1000,
  };
  return evaluateDecayCandidates(memories, referenceTime ?? new Date(), decayConfig);
}

/** Archive memories identified by the decay cycle. */
export async function archiveDecayed(deps: MemoryServiceDeps, userId: string, memoryIds: string[]): Promise<number> {
  for (const id of memoryIds) {
    await deps.stores.memory.softDeleteMemory(userId, id);
    if (config.auditLoggingEnabled) emitAuditEvent('memory:delete', userId, { reason: 'decay' }, { memoryId: id });
  }
  return memoryIds.length;
}

/** Check whether the user's memory count exceeds the configured cap. */
export async function checkCap(deps: MemoryServiceDeps, userId: string): Promise<CapCheckResult> {
  const count = await deps.stores.memory.countMemories(userId);
  return checkMemoryCap(count, { maxMemories: config.memoryCapMax, warnRatio: config.memoryCapWarnRatio });
}

/**
 * Get the full mutation audit trail for a single memory.
 * Traces back through claim versions to show the complete lifecycle.
 */
export async function getAuditTrail(deps: MemoryServiceDeps, userId: string, memoryId: string): Promise<AuditTrailEntry[]> {
  const found = await deps.stores.claim.findClaimByMemoryId(userId, memoryId);
  if (!found) return [];

  return found.versions.map((v) => ({
    versionId: v.id,
    claimId: v.claim_id,
    content: v.content,
    mutationType: v.mutation_type,
    mutationReason: v.mutation_reason,
    actorModel: v.actor_model,
    contradictionConfidence: v.contradiction_confidence,
    previousVersionId: v.previous_version_id,
    supersededByVersionId: v.superseded_by_version_id,
    validFrom: v.valid_from,
    validTo: v.valid_to,
    memoryId: v.memory_id,
  }));
}

/** Get aggregate mutation statistics for a user's memory store. */
export async function getMutationSummary(deps: MemoryServiceDeps, userId: string): Promise<MutationSummary> {
  return deps.stores.claim.getUserMutationSummary(userId);
}

/** Get recent mutations for a user, ordered newest first. */
export async function getRecentMutations(deps: MemoryServiceDeps, userId: string, limit: number = 20) {
  return deps.stores.claim.getRecentMutations(userId, limit);
}

/**
 * Backfill deterministic relation slots for active legacy claims.
 * This repairs claims written before canonical slot metadata existed.
 */
export async function backfillClaimSlots(deps: MemoryServiceDeps, userId: string): Promise<ClaimSlotBackfillResult> {
  if (!deps.stores.entity) {
    return { scanned: 0, updated: 0 };
  }

  const candidates = await deps.stores.claim.listClaimsMissingSlots(userId);
  let updated = 0;

  for (const candidate of candidates) {
    const slot = await derivePersistedClaimSlot(deps, candidate.userId, candidate.memoryId);
    if (!slot) continue;
    await deps.stores.claim.updateClaimSlot(candidate.userId, candidate.claimId, slot);
    updated += 1;
  }

  return { scanned: candidates.length, updated };
}

/** Trace the supersession chain forward from a version. */
export async function getReversalChain(deps: MemoryServiceDeps, userId: string, versionId: string) {
  return deps.stores.claim.getReversalChain(userId, versionId);
}

/** Get all active lessons for a user. */
export async function getLessons(deps: MemoryServiceDeps, userId: string) {
  if (!deps.stores.lesson) return [];
  const { getUserLessons } = await import('./lesson-service.js');
  return getUserLessons(deps.stores.lesson!, userId);
}

/** Get lesson stats for a user. */
export async function getLessonStats(deps: MemoryServiceDeps, userId: string) {
  if (!deps.stores.lesson) return { totalActive: 0, byType: {} };
  const { getLessonStats: getStats } = await import('./lesson-service.js');
  return getStats(deps.stores.lesson!, userId);
}

/** Record a user-reported lesson (explicit feedback). */
export async function reportLesson(deps: MemoryServiceDeps, userId: string, pattern: string, sourceMemoryIds: string[], severity?: 'low' | 'medium' | 'high' | 'critical') {
  if (!deps.stores.lesson) throw new Error('Lessons are not enabled');
  const { recordUserReportedLesson } = await import('./lesson-service.js');
  return recordUserReportedLesson(deps.stores.lesson!, userId, pattern, sourceMemoryIds, severity);
}

/** Deactivate a lesson. */
export async function deactivateLesson(deps: MemoryServiceDeps, userId: string, lessonId: string) {
  if (!deps.stores.lesson) throw new Error('Lessons are not enabled');
  return deps.stores.lesson!.deactivateLesson(userId, lessonId);
}

/** Derive a persisted claim slot from existing entity relations. */
export async function derivePersistedClaimSlot(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
): Promise<ClaimSlotInput | null> {
  if (!deps.stores.entity) return null;

  const relations = await deps.stores.entity!.getRelationsForMemory(userId, memoryId);
  if (relations.length === 0) return null;

  return buildPersistedRelationClaimSlot(relations.map((relation) => ({
    sourceEntityId: relation.source_entity_id,
    targetEntityId: relation.target_entity_id,
    relationType: relation.relation_type,
  })));
}
