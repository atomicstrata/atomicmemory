/**
 * Conflict policy helpers for AUDN clarification and candidate expansion.
 *
 * The policy pipeline (`applyClarificationOverrides`) runs a fixed list of
 * predicates over an `AUDNDecision` + the new fact + the candidate set, and
 * lets the first one that returns a non-null decision win. Each policy is a
 * tiny function whose only job is to decide whether its trigger fires; the
 * underlying text-pattern detectors live in `./conflict-signals.js` so this
 * file stays focused on decision flow and the helper file stays focused on
 * pure string predicates.
 */

import { config } from '../config.js';
import type { AUDNDecision } from './extraction.js';
import {
  containsContradictionSignal,
  containsExplicitReplacementSignal,
  hasSafetyConflictSignal,
  hasSharedKeyword,
  hasUncertainLanguage,
  isStateTransitionFact,
} from './conflict-signals.js';
import {
  preserveAtomicFacts as preserveAtomicFactsImpl,
  resolveDecisionTarget,
} from './conflict-atomicity.js';

// Re-exported so existing consumers (e.g. `memory-storage.ts`) can keep
// importing it from `./conflict-policy.js` after the signal-helpers split.
export { extractConflictKeywords } from './conflict-signals.js';

export interface CandidateMemory {
  id: string;
  content: string;
  similarity: number;
  importance: number;
  agent_id?: string;
}

const DEFAULT_CONTRADICTION_CONFIDENCE = 0.35;
const DELETE_CONFIDENCE_BOOST = 0.1;
const MAX_CONFIDENCE = 1.0;

interface PolicyContext {
  decision: AUDNDecision;
  factText: string;
  candidates: CandidateMemory[];
  factKeywords: string[];
  factType: string | null;
}

type Policy = (ctx: PolicyContext) => AUDNDecision | null;

const POLICIES: Policy[] = [
  resolveExplicitReplacementOnClarify,
  preserveLowConfidenceClarify,
  detectUncertainConflict,
  resolveCriticalConflict,
  preserveRecommendationAttribution,
  separateStateTransition,
  supersedeInsteadOfUpdate,
];

export function applyClarificationOverrides(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
  factKeywords: string[] = [],
  factType: string | null = null,
): AUDNDecision {
  const ctx: PolicyContext = { decision, factText, candidates, factKeywords, factType };
  for (const policy of POLICIES) {
    const result = policy(ctx);
    if (result !== null) return result;
  }
  return preserveAtomicFacts(decision, factText, candidates, factKeywords, factType);
}

/**
 * AUDN returned CLARIFY but the new fact carries an explicit replacement
 * signal ("replacing X", "no longer Y", "instead of Z", "correction: ..."):
 *   - With a target that's present in the candidate set: upgrade to
 *     SUPERSEDE so the stale memory is expired.
 *   - Without a target, or with a stale/invalid target ID that doesn't
 *     resolve to any candidate: keep the CLARIFY hold. memory-audn would
 *     reject a SUPERSEDE against a missing target and fall back to
 *     canonical storage, which leaves the old memory active — same bug
 *     as routing through promoteToAdd.
 */
function resolveExplicitReplacementOnClarify(ctx: PolicyContext): AUDNDecision | null {
  if (ctx.decision.action !== 'CLARIFY') return null;
  if (!containsExplicitReplacementSignal(ctx.factText)) return null;
  const targetId = ctx.decision.targetMemoryId;
  const targetInCandidates = targetId !== null && targetId !== undefined
    && ctx.candidates.some((candidate) => candidate.id === targetId);
  return targetInCandidates ? supersede(ctx.decision) : ctx.decision;
}

function preserveLowConfidenceClarify(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldClarifyConflict(ctx.decision)) return null;
  if (containsExplicitReplacementSignal(ctx.factText)) return null;
  return ctx.decision;
}

function detectUncertainConflict(ctx: PolicyContext): AUDNDecision | null {
  if (!isUncertainConflict(ctx.factText, ctx.candidates)) return null;
  return clarify(ctx.decision, 'Uncertain contradiction detected in new fact');
}

/**
 * If the new fact contradicts a high-importance memory, require clarification
 * unless an explicit replacement signal is present (and the action is
 * already destructive). Otherwise promote to ADD so a non-contradictory
 * specialization doesn't overwrite the original.
 */
function resolveCriticalConflict(ctx: PolicyContext): AUDNDecision | null {
  if (!isCriticalConflict(ctx.decision, ctx.factText, ctx.candidates)) return null;
  const target = resolveDecisionTarget(ctx.decision, ctx.candidates);
  if (target && containsContradictionSignal(ctx.factText, target.content)) {
    if (canApplyExplicitReplacement(ctx.decision, ctx.factText)) {
      return ctx.decision.action === 'UPDATE' ? supersede(ctx.decision) : ctx.decision;
    }
    return clarify(ctx.decision, 'Critical existing memory requires clarification before replacement');
  }
  return promoteToAdd(ctx.decision);
}

function preserveRecommendationAttribution(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldPreserveRecommendationAttribution(ctx.decision, ctx.factText, ctx.candidates)) return null;
  return promoteToAdd(ctx.decision);
}

function separateStateTransition(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldSeparateStateTransition(ctx.decision, ctx.factText)) return null;
  return promoteToAdd(ctx.decision);
}

function supersedeInsteadOfUpdate(ctx: PolicyContext): AUDNDecision | null {
  if (!shouldSupersedeInsteadOfUpdate(ctx.decision, ctx.factText, ctx.candidates)) return null;
  return supersede(ctx.decision);
}

export function mergeCandidates(
  primary: CandidateMemory[],
  secondary: CandidateMemory[],
): CandidateMemory[] {
  const merged = new Map<string, CandidateMemory>();
  for (const candidate of [...primary, ...secondary]) {
    const existing = merged.get(candidate.id);
    if (!existing || candidate.similarity > existing.similarity) {
      merged.set(candidate.id, candidate);
    }
  }
  return [...merged.values()].sort((left, right) => right.similarity - left.similarity);
}

function shouldClarifyConflict(decision: AUDNDecision): boolean {
  if (decision.action === 'CLARIFY') return true;
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'DELETE') return false;
  if (decision.contradictionConfidence === null) return false;
  // DELETE is more destructive than SUPERSEDE — require higher confidence.
  const threshold = decision.action === 'DELETE'
    ? Math.min(config.clarificationConflictThreshold + DELETE_CONFIDENCE_BOOST, MAX_CONFIDENCE)
    : config.clarificationConflictThreshold;
  return decision.contradictionConfidence < threshold;
}

function isUncertainConflict(factText: string, candidates: CandidateMemory[]): boolean {
  if (candidates.length === 0) return false;
  return hasUncertainLanguage(factText);
}

function isCriticalConflict(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  // Only apply critical-conflict protection to destructive actions (SUPERSEDE/DELETE).
  // ADD is not a conflict — it stores new info alongside existing memories.
  if (decision.action === 'ADD' || decision.action === 'NOOP') return false;
  const criticalCandidate = candidates.find(
    (candidate) => candidate.importance >= 0.9 && hasSharedKeyword(factText, candidate.content),
  );
  if (!criticalCandidate) return false;
  if (decision.action === 'UPDATE') return hasSafetyConflictSignal(factText, criticalCandidate.content);
  return true;
}

function supersede(decision: AUDNDecision): AUDNDecision {
  return {
    ...decision,
    action: 'SUPERSEDE',
    updatedContent: null,
  };
}

function shouldSupersedeInsteadOfUpdate(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  if (decision.action !== 'UPDATE') return false;
  if (!decision.targetMemoryId || !decision.updatedContent) return false;
  const target = candidates.find((c) => c.id === decision.targetMemoryId);
  if (!target) return false;
  return containsContradictionSignal(factText, target.content);
}

function canApplyExplicitReplacement(decision: AUDNDecision, factText: string): boolean {
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'UPDATE') return false;
  return containsExplicitReplacementSignal(factText);
}

function shouldPreserveRecommendationAttribution(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
): boolean {
  if (decision.action !== 'SUPERSEDE' && decision.action !== 'DELETE') return false;
  if (!/\b(recommended|suggested)\b/i.test(factText)) return false;
  const target = resolveDecisionTarget(decision, candidates);
  if (!target) return false;
  return !containsContradictionSignal(factText, target.content);
}

function clarify(decision: AUDNDecision, note: string): AUDNDecision {
  return {
    ...decision,
    action: 'CLARIFY',
    clarificationNote: decision.clarificationNote ?? note,
    contradictionConfidence: decision.contradictionConfidence ?? DEFAULT_CONTRADICTION_CONFIDENCE,
  };
}

function preserveAtomicFacts(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateMemory[],
  factKeywords: string[],
  factType: string | null,
): AUDNDecision {
  return preserveAtomicFactsImpl(decision, factText, candidates, factKeywords, factType, promoteToAdd);
}

function shouldSeparateStateTransition(decision: AUDNDecision, factText: string): boolean {
  if (!isStateTransitionFact(factText)) return false;
  return decision.action === 'UPDATE' || decision.action === 'NOOP' || decision.action === 'SUPERSEDE';
}

function promoteToAdd(decision: AUDNDecision): AUDNDecision {
  return {
    ...decision,
    action: 'ADD',
    targetMemoryId: null,
    updatedContent: null,
  };
}

/** Trust context for multi-agent conflict resolution. */
export interface TrustContext {
  callerAgentId: string;
  callerTrustLevel: number;
  candidateTrustLevels: Map<string, number>;
}

/**
 * Applies trust-based overrides to AUDN decisions when the caller agent has
 * lower trust than the target memory's agent. Forces CLARIFY instead of
 * SUPERSEDE/DELETE/UPDATE to prevent low-trust agents from silently overwriting
 * high-trust memories.
 */
function applyTrustOverrides(
  decision: AUDNDecision,
  candidates: CandidateMemory[],
  trustContext: TrustContext | undefined,
): AUDNDecision {
  if (!trustContext) return decision;
  if (!isDestructiveAction(decision)) return decision;
  if (!decision.targetMemoryId) return decision;

  const targetCandidate = candidates.find((c) => c.id === decision.targetMemoryId);
  if (!targetCandidate?.agent_id) return decision;

  const targetAgentId = targetCandidate.agent_id;
  if (targetAgentId === trustContext.callerAgentId) return decision;

  const targetTrust = trustContext.candidateTrustLevels.get(targetAgentId) ?? 0.5;
  if (trustContext.callerTrustLevel >= targetTrust) return decision;

  return clarify(
    decision,
    `Low-trust agent (${trustContext.callerTrustLevel.toFixed(2)}) cannot ${decision.action.toLowerCase()} ` +
    `memory from higher-trust agent (${targetTrust.toFixed(2)})`,
  );
}

function isDestructiveAction(decision: AUDNDecision): boolean {
  return decision.action === 'SUPERSEDE' || decision.action === 'DELETE' || decision.action === 'UPDATE';
}
