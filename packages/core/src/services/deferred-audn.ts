/**
 * Deferred AUDN Reconciliation Service.
 *
 * When DEFERRED_AUDN_ENABLED=true, facts with conflict candidates
 * (0.7 ≤ similarity < 0.95) are stored immediately as ADD and flagged
 * for background reconciliation. This eliminates the 500–2000ms LLM
 * AUDN call from the synchronous ingest path.
 *
 * The reconciliation pass processes flagged memories in batches,
 * running the full LLM AUDN pipeline and applying decisions
 * (NOOP → delete, SUPERSEDE → soft-delete original, UPDATE → merge).
 *
 * Expected latency improvement: 60–80% reduction for ingest batches
 * with moderate conflict rates (30–70% of facts hitting candidates).
 */

import type pg from 'pg';
import { config } from '../config.js';
import type { MemoryStore } from '../db/stores.js';
import {
  findDeferredMemories,
  findAllDeferredMemories,
  clearDeferredFlag,
  countDeferredMemories,
  markMemoryDeferred,
  type DeferredCandidate,
  type DeferredMemory,
} from '../db/repository-deferred-audn.js';
import { cachedResolveAUDN } from './extraction-cache.js';
import { applyClarificationOverrides, type CandidateMemory } from './conflict-policy.js';
import { embedText } from './embedding.js';
import { emitAuditEvent } from './audit-events.js';

export interface ReconciliationResult {
  processed: number;
  resolved: number;
  noops: number;
  updates: number;
  supersedes: number;
  deletes: number;
  adds: number;
  errors: number;
  durationMs: number;
}

/**
 * Check whether a set of candidates should be deferred rather than
 * resolved via LLM AUDN synchronously.
 */
export function shouldDeferAudn(
  fastDecisionResolved: boolean,
  candidateCount: number,
): boolean {
  return config.deferredAudnEnabled && !fastDecisionResolved && candidateCount > 0;
}

/**
 * Mark a newly stored memory for deferred reconciliation.
 */
export async function deferMemoryForReconciliation(
  pool: pg.Pool,
  memoryId: string,
  candidates: CandidateMemory[],
): Promise<void> {
  const serialized: DeferredCandidate[] = candidates.map((c) => ({
    id: c.id,
    content: c.content,
    similarity: c.similarity,
  }));
  await markMemoryDeferred(pool, memoryId, serialized);
}

/** Run a reconciliation pass for a single user. */
export async function reconcileUser(
  pool: pg.Pool,
  repo: MemoryStore,
  userId: string,
  batchSize: number = config.deferredAudnBatchSize,
): Promise<ReconciliationResult> {
  const start = Date.now();
  const deferred = await findDeferredMemories(pool, userId, batchSize);
  return processReconciliationBatch(pool, repo, deferred, start);
}

/** Run a reconciliation pass across all users. */
export async function reconcileAll(
  pool: pg.Pool,
  repo: MemoryStore,
  batchSize: number = config.deferredAudnBatchSize,
): Promise<ReconciliationResult> {
  const start = Date.now();
  const deferred = await findAllDeferredMemories(pool, batchSize);
  return processReconciliationBatch(pool, repo, deferred, start);
}

/** Get reconciliation status for a user. */
export async function getReconciliationStatus(
  pool: pg.Pool,
  userId: string,
): Promise<{ pending: number; enabled: boolean }> {
  const pending = await countDeferredMemories(pool, userId);
  return { pending, enabled: config.deferredAudnEnabled };
}

async function processReconciliationBatch(
  pool: pg.Pool,
  repo: MemoryStore,
  deferred: DeferredMemory[],
  startMs: number,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0, resolved: 0, noops: 0, updates: 0,
    supersedes: 0, deletes: 0, adds: 0, errors: 0, durationMs: 0,
  };

  for (const memory of deferred) {
    result.processed++;
    try {
      const action = await reconcileSingleMemory(pool, repo, memory);
      result.resolved++;
      switch (action) {
        case 'NOOP': result.noops++; break;
        case 'UPDATE': result.updates++; break;
        case 'SUPERSEDE': result.supersedes++; break;
        case 'DELETE': result.deletes++; break;
        case 'ADD': result.adds++; break;
      }
    } catch (err) {
      result.errors++;
      console.error(`[deferred-audn] Error reconciling memory ${memory.id}:`, err);
    }
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

async function reconcileSingleMemory(
  pool: pg.Pool,
  repo: MemoryStore,
  memory: DeferredMemory,
): Promise<string> {
  const candidates = await refreshCandidates(repo, memory.userId, memory.candidates);

  if (candidates.length === 0) {
    await clearDeferredFlag(pool, memory.id);
    return 'ADD';
  }

  const decision = applyClarificationOverrides(
    await cachedResolveAUDN(memory.content, candidates),
    memory.content,
    candidates,
    [],
    'knowledge',
  );

  await applyDeferredDecision(pool, repo, memory, decision);
  await clearDeferredFlag(pool, memory.id);

  if (config.auditLoggingEnabled) {
    emitAuditEvent('deferred-audn:reconcile', memory.userId, {
      memoryId: memory.id,
      action: decision.action,
      targetMemoryId: decision.targetMemoryId,
    });
  }

  return decision.action;
}

/**
 * Refresh candidate data — candidates stored at ingest time may have
 * been modified or deleted since. Re-fetch from DB to ensure accuracy.
 */
async function refreshCandidates(
  repo: MemoryStore,
  userId: string,
  storedCandidates: DeferredCandidate[],
): Promise<CandidateMemory[]> {
  const refreshed: CandidateMemory[] = [];
  for (const candidate of storedCandidates) {
    const memory = await repo.getMemory(candidate.id, userId);
    if (memory && !memory.deleted_at) {
      refreshed.push({
        id: memory.id,
        content: memory.content,
        similarity: candidate.similarity,
        importance: memory.importance,
      });
    }
  }
  return refreshed;
}

interface DeferredDecision {
  action: string;
  targetMemoryId: string | null;
  updatedContent: string | null;
}

async function applyDeferredDecision(
  pool: pg.Pool,
  repo: MemoryStore,
  memory: DeferredMemory,
  decision: DeferredDecision,
): Promise<void> {
  switch (decision.action) {
    case 'NOOP':
      await applyNoopDecision(repo, memory);
      return;
    case 'UPDATE':
      await applyUpdateDecision(repo, memory, decision);
      return;
    case 'SUPERSEDE':
      await applySupersedeDecision(repo, memory, decision);
      return;
    case 'DELETE':
      await applyDeleteDecision(repo, memory);
      return;
    case 'ADD':
      logAddDecision(memory);
      return;
    default:
      logUnknownDecision(memory, decision.action);
      return;
  }
}

async function applyNoopDecision(repo: MemoryStore, memory: DeferredMemory): Promise<void> {
  await repo.softDeleteMemory(memory.userId, memory.id);
  console.log(`[deferred-audn] NOOP: deleted duplicate ${memory.id}`);
}

async function applyUpdateDecision(
  repo: MemoryStore,
  memory: DeferredMemory,
  decision: DeferredDecision,
): Promise<void> {
  if (!decision.targetMemoryId || !decision.updatedContent) return;
  const target = await repo.getMemory(decision.targetMemoryId, memory.userId);
  const newEmbedding = await embedText(decision.updatedContent);
  await repo.updateMemoryContent(
    memory.userId,
    decision.targetMemoryId,
    decision.updatedContent,
    newEmbedding,
    target?.importance ?? 0.5,
  );
  await repo.softDeleteMemory(memory.userId, memory.id);
  console.log(`[deferred-audn] UPDATE: merged ${memory.id} into ${decision.targetMemoryId}`);
}

async function applySupersedeDecision(
  repo: MemoryStore,
  memory: DeferredMemory,
  decision: DeferredDecision,
): Promise<void> {
  if (!decision.targetMemoryId) return;
  await repo.softDeleteMemory(memory.userId, decision.targetMemoryId);
  console.log(`[deferred-audn] SUPERSEDE: ${memory.id} replaces ${decision.targetMemoryId}`);
}

async function applyDeleteDecision(repo: MemoryStore, memory: DeferredMemory): Promise<void> {
  await repo.softDeleteMemory(memory.userId, memory.id);
  console.log(`[deferred-audn] DELETE: removed ${memory.id}`);
}

function logAddDecision(memory: DeferredMemory): void {
  console.log(`[deferred-audn] ADD: confirmed ${memory.id} is distinct`);
}

function logUnknownDecision(memory: DeferredMemory, action: string): void {
  console.log(`[deferred-audn] ${action}: no action for ${memory.id}`);
}
