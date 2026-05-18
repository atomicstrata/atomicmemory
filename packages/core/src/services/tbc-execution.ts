/**
 * Typed Belief Calculus (TBC) — Phase 2 executor.
 *
 * Bridges a `BeliefOperationDecision` produced by `decideBeliefOperator`
 * to the existing AUDN ingest pipeline. Affirm / Update / Retract /
 * Supersede route to the standard AUDN executor (`executeAudnDecision`).
 * Promote / Demote / EvidenceFor / Counter are TBC-only and are handled
 * inline against `MemoryStore.updateMemoryMetadata` — no schema change in
 * this phase.
 *
 * Fail-closed: if the LLM resolver throws, the error propagates to the
 * caller. We never fall back to `ADD` silently, matching AUDN semantics.
 *
 * Schema rule: Phase 2 writes belief state into existing JSONB metadata
 * only. No new columns or tables are touched.
 */

import { timed } from './timing.js';
import { executeAudnDecision } from './audn-decision-executor.js';
import { storeCanonicalFact } from './memory-storage.js';
import {
  BeliefOperator,
  decideBeliefOperator,
  type BeliefMetadata,
  type BeliefOperationDecision,
  type BeliefRevisionEntry,
} from './typed-belief-calculus.js';
import type { CandidateMemory } from './conflict-policy.js';
import type { AUDNAction, AUDNDecision } from './extraction.js';
import type { MemoryMetadata } from '../db/repository-types.js';
import type { AudnTraceContext } from './memory-audn.js';
import type {
  AudnFactContext,
  FactResult,
  IngestFactTrace,
  IngestTraceAction,
  IngestTraceReasonCode,
  MemoryServiceDeps,
  Outcome,
} from './memory-service-types.js';

const DEMOTE_DELTA_FLOOR = -1.0;

// ---------------------------------------------------------------------------
// Dual-write hook (Phase 3)
// ---------------------------------------------------------------------------
//
// When TBC Phase 3 schema is applied (memories.confidence/belief_tier/
// mutation_type columns + belief_edges table), this module-level hook lets
// us write to the new columns/edges in addition to the existing JSONB
// metadata path. Pre-Phase-3 deployments leave the hook unset and Phase 2
// metadata-only behavior is unchanged.
//
// Production glue: wireBeliefDualWrite(repo, memoryStore) installs a hook
// backed by BeliefEdgesRepository + a column-update SQL helper. Tests
// inject a mock hook to assert the new code paths fire.

export type BeliefTier = 'standard' | 'directive' | 'demoted' | 'retracted';

export interface DualWriteEdgeInput {
  userId: string;
  sourceId: string;
  targetId: string;
  edgeType: 'evidence_for' | 'counter' | 'supersedes' | 'promotes' | 'demotes';
  weight: number;
  rationale: string;
}

export interface DualWriteColumnUpdate {
  userId: string;
  memoryId: string;
  confidence?: number;
  beliefTier?: BeliefTier;
  mutationType?: BeliefOperator;
}

export interface BeliefDualWriteHook {
  appendEdge(input: DualWriteEdgeInput): Promise<void>;
  updateColumns(input: DualWriteColumnUpdate): Promise<void>;
}

let dualWriteHook: BeliefDualWriteHook | undefined;

/** Install a dual-write hook. Pass `undefined` to clear (e.g., in tests). */
export function setBeliefDualWriteHook(hook: BeliefDualWriteHook | undefined): void {
  dualWriteHook = hook;
}

async function dualWriteEdge(input: DualWriteEdgeInput): Promise<void> {
  if (!dualWriteHook) return;
  await dualWriteHook.appendEdge(input);
}

async function dualWriteColumns(input: DualWriteColumnUpdate): Promise<void> {
  if (!dualWriteHook) return;
  await dualWriteHook.updateColumns(input);
}

/** Resolve a TBC decision via the LLM resolver and execute it. */
export async function resolveAndExecuteTbc(
  deps: MemoryServiceDeps,
  ctx: AudnFactContext,
  candidates: readonly CandidateMemory[],
  candidateIds: Set<string>,
  supersededTargets: Set<string>,
  traceContext: AudnTraceContext,
): Promise<FactResult> {
  const decision = await timed(
    'ingest.fact.tbc',
    () => decideBeliefOperator(ctx.fact, candidates),
  );
  const executed = await executeTbcDecision(deps, decision, ctx, candidateIds);
  if (decision.operator === BeliefOperator.Supersede && executed.memoryId) {
    supersededTargets.add(executed.memoryId);
  }
  return {
    ...executed,
    embedding: ctx.embedding,
    trace: buildTbcTrace(traceContext, decision, executed),
  };
}

/** Dispatch a TBC decision to the right executor branch. */
export async function executeTbcDecision(
  deps: MemoryServiceDeps,
  decision: BeliefOperationDecision,
  ctx: AudnFactContext,
  candidateIds: Set<string>,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  switch (decision.operator) {
    case BeliefOperator.Affirm:
    case BeliefOperator.Update:
    case BeliefOperator.Retract:
    case BeliefOperator.Supersede:
      return executeAudnDecision(deps, toAudnDecision(decision, ctx), candidateIds, ctx);
    case BeliefOperator.Promote:
      return executePromote(deps, decision, ctx);
    case BeliefOperator.Demote:
      return executeDemote(deps, decision, ctx);
    case BeliefOperator.EvidenceFor:
      return executeEdge(deps, decision, ctx, 'evidence_for');
    case BeliefOperator.Counter:
      return executeEdge(deps, decision, ctx, 'counter');
  }
}

/** Build an AUDN-shape decision from a TBC decision for the four shared operators. */
function toAudnDecision(
  decision: BeliefOperationDecision,
  ctx: AudnFactContext,
): AUDNDecision {
  const action = mapToAudnAction(decision.operator);
  const targetMemoryId = decision.target_claim_id ?? null;
  const updatedContent = action === 'UPDATE' ? ctx.fact.fact : null;
  return { action, targetMemoryId, updatedContent, contradictionConfidence: null, clarificationNote: null };
}

function mapToAudnAction(operator: BeliefOperator): AUDNAction {
  if (operator === BeliefOperator.Affirm) return 'NOOP';
  if (operator === BeliefOperator.Update) return 'UPDATE';
  if (operator === BeliefOperator.Retract) return 'DELETE';
  if (operator === BeliefOperator.Supersede) return 'SUPERSEDE';
  throw new Error(`mapToAudnAction: ${operator} is TBC-only`);
}

/** Promote: write directive flag + mutation_type into existing target metadata. */
async function executePromote(
  deps: MemoryServiceDeps,
  decision: BeliefOperationDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const targetId = requireTarget(decision, BeliefOperator.Promote);
  const target = await deps.stores.memory.getMemory(targetId, ctx.userId);
  if (!target) {
    return storeCanonicalFact(deps, ctx);
  }
  const current = readBeliefMetadata(target.metadata);
  const nextConfidence = clamp(currentConfidence(current) + Math.max(0, decision.confidence_delta));
  const nextHistory = appendRevision(current.revision_history, {
    operator: BeliefOperator.Promote,
    confidence: nextConfidence,
    content: target.content,
    recordedAt: new Date().toISOString(),
    rationale: decision.rationale,
  });
  await deps.stores.memory.updateMemoryMetadata(ctx.userId, targetId, {
    ...target.metadata,
    mutation_type: BeliefOperator.Promote,
    directive: true,
    confidence: nextConfidence,
    revision_history: nextHistory,
  } satisfies BeliefMetadata);
  // Phase 3 dual-write: column update + promotes edge from new claim → target
  await dualWriteColumns({
    userId: ctx.userId,
    memoryId: targetId,
    confidence: nextConfidence,
    beliefTier: 'directive',
    mutationType: BeliefOperator.Promote,
  });
  await dualWriteEdge({
    userId: ctx.userId,
    sourceId: targetId,
    targetId,
    edgeType: 'promotes',
    weight: clamp(Math.max(0, decision.confidence_delta), 0, 1),
    rationale: decision.rationale,
  });
  return { outcome: 'updated', memoryId: targetId };
}

/** Demote: lower confidence and record the soft-conflict revision. */
async function executeDemote(
  deps: MemoryServiceDeps,
  decision: BeliefOperationDecision,
  ctx: AudnFactContext,
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const targetId = requireTarget(decision, BeliefOperator.Demote);
  const target = await deps.stores.memory.getMemory(targetId, ctx.userId);
  if (!target) {
    return storeCanonicalFact(deps, ctx);
  }
  const current = readBeliefMetadata(target.metadata);
  const delta = Math.min(0, Math.max(DEMOTE_DELTA_FLOOR, decision.confidence_delta));
  const nextConfidence = clamp(currentConfidence(current) + delta);
  const nextHistory = appendRevision(current.revision_history, {
    operator: BeliefOperator.Demote,
    confidence: nextConfidence,
    content: target.content,
    recordedAt: new Date().toISOString(),
    rationale: decision.rationale,
  });
  await deps.stores.memory.updateMemoryMetadata(ctx.userId, targetId, {
    ...target.metadata,
    mutation_type: BeliefOperator.Demote,
    confidence: nextConfidence,
    revision_history: nextHistory,
  } satisfies BeliefMetadata);
  // Phase 3 dual-write: column update + demotes edge with negative weight
  await dualWriteColumns({
    userId: ctx.userId,
    memoryId: targetId,
    confidence: nextConfidence,
    beliefTier: 'demoted',
    mutationType: BeliefOperator.Demote,
  });
  await dualWriteEdge({
    userId: ctx.userId,
    sourceId: targetId,
    targetId,
    edgeType: 'demotes',
    weight: -clamp(Math.abs(delta), 0, 1),
    rationale: decision.rationale,
  });
  return { outcome: 'updated', memoryId: targetId };
}

/** EvidenceFor / Counter: append a graph-only edge into the target's metadata. */
async function executeEdge(
  deps: MemoryServiceDeps,
  decision: BeliefOperationDecision,
  ctx: AudnFactContext,
  edgeType: 'evidence_for' | 'counter',
): Promise<{ outcome: Outcome; memoryId: string | null }> {
  const operator = edgeType === 'evidence_for' ? BeliefOperator.EvidenceFor : BeliefOperator.Counter;
  const targetId = requireTarget(decision, operator);
  const target = await deps.stores.memory.getMemory(targetId, ctx.userId);
  if (!target) {
    return storeCanonicalFact(deps, ctx);
  }
  const current = readBeliefMetadata(target.metadata);
  const weight = edgeType === 'evidence_for'
    ? clamp(Math.max(0, decision.confidence_delta), 0, 1)
    : -clamp(Math.abs(Math.min(0, decision.confidence_delta)), 0, 1);
  const entry: BeliefRevisionEntry = {
    operator,
    confidence: currentConfidence(current),
    content: null,
    recordedAt: new Date().toISOString(),
    rationale: decision.rationale,
    weight,
  };
  const nextEdges = appendRevision(current.belief_edges, entry);
  await deps.stores.memory.updateMemoryMetadata(ctx.userId, targetId, {
    ...target.metadata,
    mutation_type: operator,
    belief_edges: nextEdges,
  } satisfies BeliefMetadata);
  // Phase 3 dual-write: typed edge into belief_edges + mutation_type column.
  // Source is the new claim (not yet stored as a row) — for now we record
  // target → target with the rationale; Phase 4 will store the source claim
  // first and link the edge to the new memory row.
  await dualWriteColumns({
    userId: ctx.userId,
    memoryId: targetId,
    mutationType: operator,
  });
  await dualWriteEdge({
    userId: ctx.userId,
    sourceId: targetId,
    targetId,
    edgeType,
    weight,
    rationale: decision.rationale,
  });
  return { outcome: 'updated', memoryId: targetId };
}

function readBeliefMetadata(metadata: MemoryMetadata): BeliefMetadata {
  return metadata as BeliefMetadata;
}

function currentConfidence(meta: BeliefMetadata): number {
  return typeof meta.confidence === 'number' && Number.isFinite(meta.confidence) ? meta.confidence : 1.0;
}

function appendRevision(
  prior: BeliefRevisionEntry[] | undefined,
  entry: BeliefRevisionEntry,
): BeliefRevisionEntry[] {
  return [entry, ...(prior ?? [])];
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function requireTarget(decision: BeliefOperationDecision, operator: BeliefOperator): string {
  if (!decision.target_claim_id) {
    throw new Error(`TBC ${operator} requires target_claim_id but resolver returned none`);
  }
  return decision.target_claim_id;
}

function reasonCodeForOperator(operator: BeliefOperator): IngestTraceReasonCode {
  const map: Record<BeliefOperator, IngestTraceReasonCode> = {
    [BeliefOperator.Affirm]: 'tbc-affirm',
    [BeliefOperator.Update]: 'tbc-update',
    [BeliefOperator.Retract]: 'tbc-retract',
    [BeliefOperator.Supersede]: 'tbc-supersede',
    [BeliefOperator.Promote]: 'tbc-promote',
    [BeliefOperator.Demote]: 'tbc-demote',
    [BeliefOperator.EvidenceFor]: 'tbc-evidence-for',
    [BeliefOperator.Counter]: 'tbc-counter',
  };
  return map[operator];
}

function actionForOperator(operator: BeliefOperator): IngestTraceAction {
  if (operator === BeliefOperator.Affirm) return 'NOOP';
  if (operator === BeliefOperator.Update) return 'UPDATE';
  if (operator === BeliefOperator.Retract) return 'DELETE';
  if (operator === BeliefOperator.Supersede) return 'SUPERSEDE';
  return 'UPDATE';
}

function buildTbcTrace(
  traceContext: AudnTraceContext,
  decision: BeliefOperationDecision,
  result: { outcome: Outcome; memoryId: string | null },
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
      source: 'tbc',
      action: actionForOperator(decision.operator),
      reasonCode: reasonCodeForOperator(decision.operator),
      targetMemoryId: decision.target_claim_id ?? null,
      candidateIds: traceContext.candidates.map((candidate) => candidate.id),
      beliefOperator: decision.operator,
    },
    outcome: result.outcome,
    memoryId: result.memoryId,
    beliefOperator: decision.operator,
  };
}
