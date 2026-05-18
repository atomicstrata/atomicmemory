/**
 * Shared AUDN decision executor for canonical memory mutations.
 * Kept separate from memory-audn.ts so TBC can reuse the AUDN mutation path
 * without importing the full AUDN resolver and creating an import cycle.
 */

import { type MemoryRow } from '../db/repository-types.js';
import { embedText } from './embedding.js';
import { type AUDNDecision } from './extraction.js';
import { emitAuditEvent } from './audit-events.js';
import { recordContradictionLesson } from './lesson-service.js';
import { emitLineageEvent } from './memory-lineage.js';
import { applyOpinionSignal, audnActionToOpinionSignal } from './memory-network.js';
import { buildAtomicFactProjection, buildForesightProjections } from './memcell-projection.js';
import {
  ensureClaimTarget,
  storeCanonicalFact,
  storeProjection,
} from './memory-storage.js';
import type {
  AudnFactContext,
  FactInput,
  MemoryServiceDeps,
  Outcome,
} from './memory-service-types.js';

/** Execute an AUDN decision through the standard ingest mutation path. */
export async function executeAudnDecision(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  candidateIds: Set<string>,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const opinionResult = await tryOpinionIntercept(deps, decision, ctx);
  if (opinionResult) return opinionResult;

  if (decision.action === 'ADD') {
    return storeCanonicalFact(deps, ctx);
  }
  if (decision.action === 'NOOP') {
    return recordNoop(deps, decision.targetMemoryId, candidateIds, ctx.userId, ctx.episodeId, ctx.fact.fact);
  }
  if (decision.action === 'CLARIFY') {
    return storeClarification(deps, decision, ctx);
  }
  if (!decision.targetMemoryId || !candidateIds.has(decision.targetMemoryId)) {
    console.error(`AUDN ${decision.action} rejected for fact "${ctx.fact.fact.slice(0, 50)}...": invalid targetMemoryId "${decision.targetMemoryId}". Candidates were: ${[...candidateIds].join(', ')}`);
    return storeCanonicalFact(deps, ctx);
  }
  return executeMutationDecision(deps, decision, ctx);
}

/** Handle opinion network intercept: update confidence instead of normal AUDN. */
async function tryOpinionIntercept(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null } | null> {
  if (!canApplyOpinionIntercept(decision, ctx)) return null;

  const targetMemory = await deps.stores.memory.getMemory(decision.targetMemoryId!, ctx.userId);
  if (!isOpinionTarget(targetMemory)) return null;

  const newConfidence = applyOpinionSignal(
    targetMemory.opinion_confidence,
    audnActionToOpinionSignal(decision.action),
  );
  await deps.stores.memory.updateOpinionConfidence(ctx.userId, decision.targetMemoryId!, newConfidence);
  await maybeStoreOpinionClarification(deps, decision, ctx, targetMemory, newConfidence);

  if (decision.action === 'SUPERSEDE') {
    return storeCanonicalFact(deps, ctx);
  }
  return {
    outcome: decision.action === 'NOOP' ? 'skipped' : 'updated',
    memoryId: decision.targetMemoryId,
  };
}

function canApplyOpinionIntercept(decision: AUDNDecision, ctx: AudnFactContext): boolean {
  return ctx.fact.network === 'opinion' && Boolean(decision.targetMemoryId) && decision.action !== 'ADD';
}

function isOpinionTarget(memory: MemoryRow | null): memory is MemoryRow & { opinion_confidence: number } {
  return Boolean(memory && memory.network === 'opinion' && memory.opinion_confidence !== null);
}

async function maybeStoreOpinionClarification(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
  targetMemory: MemoryRow & { opinion_confidence: number },
  newConfidence: number,
): Promise<void> {
  if (newConfidence > 0 || targetMemory.opinion_confidence <= 0) return;
  await deps.stores.memory.storeMemory({
    userId: ctx.userId,
    content: ctx.fact.fact,
    embedding: ctx.embedding,
    memoryType: 'episodic',
    importance: ctx.fact.importance,
    sourceSite: ctx.sourceSite,
    sourceUrl: ctx.sourceUrl,
    episodeId: ctx.episodeId,
    status: 'needs_clarification',
    metadata: {
      clarification_note: 'Opinion confidence dropped to zero',
      target_memory_id: decision.targetMemoryId!,
    },
    trustScore: ctx.trustScore,
    network: 'opinion',
    opinionConfidence: 0,
    createdAt: ctx.logicalTimestamp,
    observedAt: ctx.logicalTimestamp,
    workspaceId: ctx.workspace?.workspaceId,
    agentId: ctx.workspace?.agentId,
    visibility: ctx.workspace?.visibility,
  });
}

/** Store a fact as needs_clarification for the CLARIFY action. */
async function storeClarification(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  await deps.stores.memory.storeMemory({
    userId: ctx.userId, content: ctx.fact.fact, embedding: ctx.embedding,
    memoryType: ctx.fact.type === 'knowledge' ? 'semantic' : 'episodic',
    importance: ctx.fact.importance, sourceSite: ctx.sourceSite, sourceUrl: ctx.sourceUrl, episodeId: ctx.episodeId,
    status: 'needs_clarification',
    metadata: {
      clarification_note: decision.clarificationNote ?? 'Low-confidence contradiction detected',
      target_memory_id: decision.targetMemoryId ?? undefined,
      contradiction_confidence: decision.contradictionConfidence ?? undefined,
    },
    trustScore: ctx.trustScore, createdAt: ctx.logicalTimestamp, observedAt: ctx.logicalTimestamp,
    workspaceId: ctx.workspace?.workspaceId, agentId: ctx.workspace?.agentId, visibility: ctx.workspace?.visibility,
  });
  return { outcome: 'skipped' as Outcome, memoryId: null };
}

/** Execute UPDATE, DELETE, or SUPERSEDE. Mutation errors intentionally bubble. */
async function executeMutationDecision(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  if (decision.action === 'UPDATE') {
    return await updateCanonicalFact(deps, decision, ctx);
  }
  if (shouldPreserveBilateralContradiction(deps, decision)) {
    return await preserveBilateralContradiction(deps, decision, ctx);
  }
  if (decision.action === 'DELETE') {
    return await deleteCanonicalFact(deps, decision, ctx);
  }
  return await supersedeCanonicalFact(deps, decision, ctx);
}

function shouldPreserveBilateralContradiction(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
): boolean {
  return (
    (decision.action === 'DELETE' || decision.action === 'SUPERSEDE') &&
    deps.config.contradictionPreservationEnabled &&
    Boolean(deps.stores.contradictions)
  );
}

async function preserveBilateralContradiction(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const contradictions = deps.stores.contradictions;
  if (!contradictions) {
    throw new Error('AUDN bilateral preservation: contradictions store missing.');
  }
  const targetMemoryId = decision.targetMemoryId;
  if (!targetMemoryId) {
    throw new Error('AUDN bilateral preservation: missing targetMemoryId.');
  }
  const existing = await deps.stores.memory.getMemoryIncludingDeleted(targetMemoryId, ctx.userId);
  if (!existing) {
    throw new Error(`AUDN bilateral preservation: target memory ${targetMemoryId} not found.`);
  }
  const newMemoryId = await storeCanonicalProjection(deps, ctx);
  if (!newMemoryId) {
    throw new Error(`AUDN bilateral preservation: storeProjection returned no id for target ${targetMemoryId}.`);
  }
  await contradictions.record({
    userId: ctx.userId,
    conversationId: ctx.episodeId,
    leftMemoryId: existing.id,
    rightMemoryId: newMemoryId,
    leftSummary: existing.content,
    rightSummary: ctx.fact.fact,
  });
  await contradictions.markContradictionFlagsBilateral(ctx.userId, existing.id, newMemoryId);
  if (deps.config.auditLoggingEnabled) {
    emitAuditEvent('memory:contradiction-preserved', ctx.userId, {
      action: decision.action,
      leftMemoryId: existing.id,
      rightMemoryId: newMemoryId,
      contradictionConfidence: decision.contradictionConfidence,
    }, { memoryId: newMemoryId });
  }
  return { outcome: 'preserved_contradiction', memoryId: newMemoryId };
}

async function updateCanonicalFact(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const { userId, fact, sourceSite, sourceUrl, episodeId, trustScore, logicalTimestamp, workspace } = ctx;
  if (!decision.updatedContent) {
    throw new Error(`AUDN UPDATE failed: missing updatedContent for target "${decision.targetMemoryId}"`);
  }
  const target = await ensureClaimTarget(deps, userId, decision.targetMemoryId!);
  const updatedEmbedding = await embedText(decision.updatedContent);
  await deps.stores.memory.updateMemoryContent(userId, target.memoryId, decision.updatedContent, updatedEmbedding, fact.importance, fact.keywords.join(' '), trustScore);
  const updatedFact = { ...fact, fact: decision.updatedContent };
  await replaceUpdatedProjections(deps, ctx, updatedFact, updatedEmbedding, target.memoryId);
  const lineage = await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-update',
    userId,
    fact,
    updatedContent: decision.updatedContent,
    updatedEmbedding,
    sourceSite,
    sourceUrl,
    episodeId,
    logicalTimestamp,
    target,
    contradictionConfidence: decision.contradictionConfidence,
  });
  if (!lineage?.cmoId) {
    throw new Error(`AUDN UPDATE failed: missing successor canonical object for "${target.memoryId}"`);
  }
  await deps.stores.memory.updateMemoryMetadata(userId, target.memoryId, { cmo_id: lineage.cmoId });
  return { outcome: 'updated', memoryId: target.memoryId };
}

async function storeCanonicalProjection(
  deps: MemoryServiceDeps,
  ctx: AudnFactContext,
): Promise<string | null> {
  return storeProjection(
    deps, ctx.userId, ctx.fact, ctx.embedding,
    ctx.sourceSite, ctx.sourceUrl, ctx.episodeId,
    ctx.trustScore, { logicalTimestamp: ctx.logicalTimestamp, workspace: ctx.workspace },
  );
}

async function replaceUpdatedProjections(
  deps: MemoryServiceDeps,
  ctx: AudnFactContext,
  updatedFact: FactInput,
  updatedEmbedding: number[],
  targetMemoryId: string,
): Promise<void> {
  const { userId, sourceSite, sourceUrl, episodeId, workspace } = ctx;
  const updatedAtomicFact = buildAtomicFactProjection(updatedFact, updatedEmbedding);
  await deps.stores.representation.replaceAtomicFactsForMemory(userId, targetMemoryId, [{
    userId, parentMemoryId: targetMemoryId,
    factText: updatedAtomicFact.factText, embedding: updatedAtomicFact.embedding,
    factType: updatedAtomicFact.factType, importance: updatedAtomicFact.importance,
    sourceSite, sourceUrl, episodeId,
    keywords: updatedAtomicFact.keywords.join(' '), metadata: updatedAtomicFact.metadata,
    workspaceId: workspace?.workspaceId, agentId: workspace?.agentId,
  }]);
  const updatedForesight = buildForesightProjections(updatedFact, updatedEmbedding);
  await deps.stores.representation.replaceForesightForMemory(userId, targetMemoryId,
    updatedForesight.map((entry) => ({
      userId, parentMemoryId: targetMemoryId,
      content: entry.content, embedding: entry.embedding, foresightType: entry.foresightType,
      sourceSite, sourceUrl, episodeId,
      metadata: entry.metadata, validFrom: entry.validFrom, validTo: entry.validTo,
      workspaceId: workspace?.workspaceId, agentId: workspace?.agentId,
    })),
  );
}

async function supersedeCanonicalFact(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const target = await ensureClaimTarget(deps, ctx.userId, decision.targetMemoryId!);
  await deps.stores.memory.expireMemory(ctx.userId, target.memoryId);
  const newMemoryId = await storeCanonicalProjection(deps, ctx);
  if (!newMemoryId) return { outcome: 'skipped', memoryId: null };
  const lineage = await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-supersede',
    userId: ctx.userId,
    fact: ctx.fact,
    embedding: ctx.embedding,
    sourceSite: ctx.sourceSite,
    sourceUrl: ctx.sourceUrl,
    episodeId: ctx.episodeId,
    logicalTimestamp: ctx.logicalTimestamp,
    target,
    newMemoryId,
    contradictionConfidence: decision.contradictionConfidence,
  });
  if (!lineage?.cmoId) {
    throw new Error(`AUDN SUPERSEDE failed: missing successor canonical object for "${target.memoryId}"`);
  }
  await deps.stores.memory.updateMemoryMetadata(ctx.userId, newMemoryId, { cmo_id: lineage.cmoId });
  maybeRecordContradictionLesson(deps, decision, ctx, target.memoryId);
  return { outcome: 'deleted', memoryId: newMemoryId };
}

function maybeRecordContradictionLesson(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
  supersededMemoryId: string,
): void {
  if (!deps.config.lessonsEnabled || !deps.stores.lesson || !decision.contradictionConfidence) return;
  recordContradictionLesson(deps.stores.lesson, {
    userId: ctx.userId,
    content: ctx.fact.fact,
    sourceSite: ctx.sourceSite,
    contradictionConfidence: decision.contradictionConfidence,
    supersededMemoryId,
  }).catch((err) => console.error('Lesson recording failed:', err));
}

/** Handle AUDN DELETE: soft-delete the old memory without creating a replacement. */
async function deleteCanonicalFact(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const target = await ensureClaimTarget(deps, ctx.userId, decision.targetMemoryId!);
  const targetMemory = await deps.stores.memory.getMemoryIncludingDeleted(target.memoryId, ctx.userId);
  if (!targetMemory) return { outcome: 'skipped', memoryId: null };
  await deps.stores.memory.softDeleteMemory(ctx.userId, target.memoryId);
  await emitLineageEvent({ claims: deps.stores.claim, repo: deps.stores.memory, config: deps.config }, {
    kind: 'canonical-delete',
    userId: ctx.userId,
    fact: ctx.fact,
    sourceSite: ctx.sourceSite,
    sourceUrl: ctx.sourceUrl,
    episodeId: ctx.episodeId,
    logicalTimestamp: ctx.logicalTimestamp,
    target,
    targetEmbedding: targetMemory.embedding,
    contradictionConfidence: decision.contradictionConfidence,
  });
  if (deps.config.auditLoggingEnabled) {
    emitAuditEvent('memory:delete', ctx.userId, {
      reason: 'audn-delete', targetMemoryId: target.memoryId, contradictionConfidence: decision.contradictionConfidence,
    }, { memoryId: target.memoryId });
  }
  return { outcome: 'deleted', memoryId: null };
}

async function recordNoop(
  deps: MemoryServiceDeps,
  targetMemoryId: string | null,
  candidateIds: Set<string>,
  userId: string,
  episodeId: string,
  quoteText: string,
): Promise<{ outcome: Outcome; memoryId: null }> {
  if (!targetMemoryId || !candidateIds.has(targetMemoryId)) return { outcome: 'skipped', memoryId: null };
  try {
    const target = await ensureClaimTarget(deps, userId, targetMemoryId);
    await deps.stores.claim.addEvidence({ claimVersionId: target.versionId, episodeId, memoryId: target.memoryId, quoteText });
  } catch {
    // Target memory may not exist if AUDN decision was cached from a previous run.
    // Safe to skip -- NOOP means "do nothing."
  }
  return { outcome: 'skipped', memoryId: null };
}
