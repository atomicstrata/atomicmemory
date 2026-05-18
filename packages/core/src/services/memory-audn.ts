/**
 * AUDN (Add/Update/Delete/Noop) decision resolution and mutation execution.
 * Handles fast-path AUDN, deferred AUDN, conflict candidate discovery,
 * and the full mutation pipeline (update, supersede, delete canonical facts).
 */

import { type ClaimSlotInput } from '../db/claim-repository.js';
import { type AUDNDecision } from './extraction.js';
import { cachedResolveAUDN } from './extraction-cache.js';
import { applyClarificationOverrides, mergeCandidates, type CandidateMemory } from './conflict-policy.js';
import { shouldDeferAudn, deferMemoryForReconciliation } from './deferred-audn.js';
import { timed } from './timing.js';
import { executeAudnDecision } from './audn-decision-executor.js';
import { storeCanonicalFact, applyEntityScopedDedup, findConflictCandidates, findSlotConflictCandidates } from './memory-storage.js';
import type {
  AudnFactContext,
  FactInput,
  FactResult,
  IngestFactTrace,
  IngestTraceAction,
  IngestTraceCandidate,
  MemoryServiceDeps,
  Outcome,
} from './memory-service-types.js';

export interface AudnTraceContext {
  fact: FactInput;
  logicalTimestamp?: Date;
  writeSecurity: { allowed: boolean; blockedBy: string | null; trust: { score: number } };
  entropyResult?: {
    score: number;
    entityNovelty: number;
    semanticNovelty: number;
    accepted: boolean;
  } | null;
  candidates: IngestTraceCandidate[];
}

/** Find conflict candidates, merge slot-aware candidates, and filter out superseded. */
export async function findFilteredCandidates(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  embedding: number[],
  claimSlot: ClaimSlotInput | null,
  supersededTargets: Set<string>,
): Promise<CandidateMemory[]> {
  const candidates = await timed('ingest.fact.find-conflicts', () => findConflictCandidates(deps, userId, fact.fact, embedding));
  const slotAwareCandidates = claimSlot
    ? await timed('ingest.fact.find-slot-candidates', () => findSlotConflictCandidates(deps, userId, claimSlot))
    : [];
  const merged = mergeCandidates(candidates, slotAwareCandidates);
  return merged.filter((c) => !supersededTargets.has(c.id));
}

/** Resolve AUDN decision (fast/deferred/full) and execute it. */
export async function resolveAndExecuteAudn(
  deps: MemoryServiceDeps,
  userId: string,
  fact: FactInput,
  embedding: number[],
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  trustScore: number,
  claimSlot: ClaimSlotInput | null,
  logicalTimestamp: Date | undefined,
  filteredCandidates: CandidateMemory[],
  supersededTargets: Set<string>,
  workspace?: import('../db/repository-types.js').WorkspaceContext,
  traceContext?: AudnTraceContext,
): Promise<FactResult> {
  const candidateIds = new Set(filteredCandidates.map((c) => c.id));
  const ctx: AudnFactContext = { userId, fact, embedding, sourceSite, sourceUrl, episodeId, trustScore, claimSlot, logicalTimestamp, workspace };

  const fastDecision = tryFastAUDN(fact.fact, filteredCandidates, deps.config);
  if (fastDecision) {
    return executeAndTrackSupersede(deps, fastDecision, candidateIds, ctx, supersededTargets, requireTraceContext(traceContext), 'fast-audn', 'NOOP', fastDecision.action);
  }

  if (shouldDeferAudn(false, filteredCandidates.length)) {
    const result = await storeCanonicalFact(deps, ctx);
    if (result.memoryId) {
      await deferMemoryForReconciliation(deps.stores.pool, result.memoryId, filteredCandidates);
      console.log(`[deferred-audn] Deferred: ${result.memoryId} (${filteredCandidates.length} candidates)`);
    }
    return {
      ...result,
      embedding,
      trace: buildAudnTrace(requireTraceContext(traceContext), 'deferred-audn', 'ADD', 'deferred-audn-store', result.outcome, result.memoryId, null),
    };
  }

  if (deps.config.tbcEnabled) {
    const { resolveAndExecuteTbc } = await import('./tbc-execution.js');
    return resolveAndExecuteTbc(deps, ctx, filteredCandidates, candidateIds, supersededTargets, requireTraceContext(traceContext));
  }

  const rawDecision = await timed('ingest.fact.audn', () => cachedResolveAUDN(fact.fact, filteredCandidates));
  let decision = applyClarificationOverrides(rawDecision, fact.fact, filteredCandidates, fact.keywords, fact.type);
  if (deps.config.entityGraphEnabled && deps.stores.entity) {
    decision = await applyEntityScopedDedup(deps, decision, userId, fact.entities);
  }
  return executeAndTrackSupersede(deps, decision, candidateIds, ctx, supersededTargets, requireTraceContext(traceContext), 'llm-audn', rawDecision.action, decision.action);
}

/** Execute the AUDN decision and track supersede targets. */
async function executeAndTrackSupersede(
  deps: MemoryServiceDeps,
  decision: AUDNDecision,
  candidateIds: Set<string>,
  ctx: AudnFactContext,
  supersededTargets: Set<string>,
  traceContext: AudnTraceContext,
  source: 'fast-audn' | 'llm-audn',
  rawAction: string | null,
  effectiveAction: IngestTraceAction,
): Promise<FactResult> {
  const result = await executeAudnDecision(deps, decision, candidateIds, ctx);
  if (decision.action === 'SUPERSEDE' && result.memoryId) {
    supersededTargets.add(result.memoryId);
  }
  return {
    ...result,
    embedding: ctx.embedding,
    trace: buildAudnTrace(
      traceContext,
      source,
      effectiveAction,
      reasonCodeForDecision(source, decision, result),
      result.outcome,
      result.memoryId,
      decision.targetMemoryId,
      rawAction,
    ),
  };
}

function buildAudnTrace(
  traceContext: AudnTraceContext,
  source: 'fast-audn' | 'deferred-audn' | 'llm-audn',
  action: IngestTraceAction,
  reasonCode: IngestFactTrace['decision']['reasonCode'],
  outcome: Outcome,
  memoryId: string | null,
  targetMemoryId: string | null,
  rawAction?: string | null,
): IngestFactTrace {
  return {
    factText: traceContext.fact.fact,
    headline: traceContext.fact.headline,
    factType: traceContext.fact.type,
    importance: traceContext.fact.importance,
    ...(traceContext.logicalTimestamp ? { logicalTimestamp: traceContext.logicalTimestamp.toISOString() } : {}),
    writeSecurity: {
      allowed: traceContext.writeSecurity.allowed,
      blockedBy: traceContext.writeSecurity.blockedBy,
      trustScore: traceContext.writeSecurity.trust.score,
    },
    ...(traceContext.entropyResult ? { entropyGate: traceContext.entropyResult } : {}),
    candidates: traceContext.candidates,
    decision: {
      source,
      action,
      reasonCode,
      targetMemoryId,
      candidateIds: traceContext.candidates.map((candidate) => candidate.id),
      ...(rawAction ? { rawAction } : {}),
    },
    outcome,
    memoryId,
  };
}

function requireTraceContext(traceContext: AudnTraceContext | undefined): AudnTraceContext {
  if (!traceContext) {
    throw new Error('resolveAndExecuteAudn requires traceContext.');
  }
  return traceContext;
}

function reasonCodeForDecision(
  source: 'fast-audn' | 'llm-audn',
  decision: AUDNDecision,
  result: { outcome: Outcome; memoryId: string | null },
): IngestFactTrace['decision']['reasonCode'] {
  if (source === 'fast-audn') return 'fast-audn-noop';
  // BEAM CR fix: bilateral preservation intercepted DELETE/SUPERSEDE.
  if (result.outcome === 'preserved_contradiction') return 'llm-audn-bilateral-preserve';
  if (isInvalidTargetFallback(decision, result)) {
    return 'invalid-target-fallback';
  }
  return decision.action === 'SUPERSEDE' && !result.memoryId
    ? 'invalid-target-fallback'
    : decisionReasonCode(decision.action);
}

function isInvalidTargetFallback(
  decision: AUDNDecision,
  result: { outcome: Outcome; memoryId: string | null },
): boolean {
  // The bilateral path emits outcome='preserved_contradiction' for DELETE
  // and SUPERSEDE — that is the intended behavior, not a stored-fallback.
  if (result.outcome === 'preserved_contradiction') return false;
  return !['ADD', 'NOOP', 'CLARIFY'].includes(decision.action) && result.outcome === 'stored';
}

function decisionReasonCode(
  action: AUDNDecision['action'],
): IngestFactTrace['decision']['reasonCode'] {
  const reasonCodes = {
    ADD: 'llm-audn-add',
    NOOP: 'llm-audn-noop',
    CLARIFY: 'llm-audn-clarify',
    UPDATE: 'llm-audn-update',
    DELETE: 'llm-audn-delete',
    SUPERSEDE: 'llm-audn-supersede',
  } satisfies Record<AUDNDecision['action'], IngestFactTrace['decision']['reasonCode']>;
  return reasonCodes[action];
}

const QUOTED_LITERAL_PATTERN = /["""'\u2018\u2019\u201C\u201D]([^"""'\u2018\u2019\u201C\u201D]{2,80})["""'\u2018\u2019\u201C\u201D]/g;

function sharesQuotedLiteral(factText: string, candidateContent: string): boolean {
  const quotedLiterals = extractQuotedLiterals(factText);
  if (quotedLiterals.length === 0) return true;
  const lowerCandidate = candidateContent.toLowerCase();
  return quotedLiterals.every((literal) => lowerCandidate.includes(literal.toLowerCase()));
}

function extractQuotedLiterals(text: string): string[] {
  const literals: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = QUOTED_LITERAL_PATTERN.exec(text)) !== null) {
    literals.push(match[1]);
  }
  return literals;
}

/**
 * Fast-path AUDN: skip the LLM call for clear-cut embedding similarity cases.
 * sim >= 0.95: near-duplicate -> NOOP (skip storing).
 * Returns null when the case is ambiguous and needs full LLM AUDN.
 * Empty candidate sets have no top peer, so they fall through to normal AUDN.
 */
function tryFastAUDN(
  factText: string,
  candidates: CandidateMemory[],
  runtimeConfig: Pick<MemoryServiceDeps['config'], 'fastAudnEnabled' | 'fastAudnDuplicateThreshold'>,
): AUDNDecision | null {
  if (!runtimeConfig.fastAudnEnabled) return null;
  if (candidates.length === 0) return null;

  const topCandidate = candidates.reduce(
    (best, c) => (c.similarity > best.similarity ? c : best),
    candidates[0],
  );

  if (!sharesQuotedLiteral(factText, topCandidate.content)) {
    return null;
  }

  if (topCandidate.similarity >= runtimeConfig.fastAudnDuplicateThreshold) {
    console.log(`[fast-audn] NOOP: sim=${topCandidate.similarity.toFixed(4)} >= ${runtimeConfig.fastAudnDuplicateThreshold} (near-duplicate of ${topCandidate.id})`);
    return {
      action: 'NOOP',
      targetMemoryId: topCandidate.id,
      updatedContent: null,
      contradictionConfidence: null,
    };
  }

  return null;
}
