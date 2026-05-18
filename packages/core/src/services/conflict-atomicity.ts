/**
 * Atomic-fact preservation for the AUDN conflict-policy pipeline.
 *
 * When a fact looks like it could merge into an existing memory (UPDATE /
 * NOOP), these helpers decide whether the merge actually preserves the
 * atomic-fact contract or whether the new fact deserves its own ADD. The
 * predicates live here so `conflict-policy.ts` can stay focused on the
 * decision flow rather than the safe-reuse heuristics.
 */

import { config } from '../config.js';
import type { AUDNDecision } from './extraction.js';
import {
  extractConflictKeywords,
  isStateTransitionFact,
} from './conflict-signals.js';

/**
 * Subset of `CandidateMemory` the atomic-boundary checks actually read.
 * Re-declared here as a structural type so this module does not import
 * `conflict-policy.ts` (which would create a cycle).
 */
interface CandidateSubset {
  id: string;
  content: string;
  similarity: number;
}

const SAFE_REUSE_MIN_SIMILARITY = config.audnSafeReuseMinSimilarity;
const SAFE_REUSE_MIN_SHARED_KEYWORDS = 2;
const SAFE_REUSE_HIGH_SIMILARITY = 0.95;
const MAX_UPDATE_GROWTH_RATIO = 1.5;

/**
 * Apply atomic-fact preservation as a fallback when no other policy fired.
 * Either passes the original decision through, or promotes it to ADD when
 * the merge target would either compound the original memory beyond its
 * atomic shape or fail the similarity+keyword safety check.
 */
export function preserveAtomicFacts(
  decision: AUDNDecision,
  factText: string,
  candidates: CandidateSubset[],
  factKeywords: string[],
  factType: string | null,
  promoteToAdd: (decision: AUDNDecision) => AUDNDecision,
): AUDNDecision {
  if (!shouldPreserveAtomicBoundary(factText, factType)) return decision;
  if (decision.action !== 'UPDATE' && decision.action !== 'NOOP') return decision;
  if (isStateTransitionFact(factText)) return promoteToAdd(decision);
  const target = resolveDecisionTarget(decision, candidates);
  if (!target) return promoteToAdd(decision);
  if (decision.action === 'UPDATE' && isContentGrowthExcessive(decision.updatedContent, target.content)) {
    return promoteToAdd(decision);
  }
  if (isSafeReuse(target, factText, factKeywords)) return decision;
  return promoteToAdd(decision);
}

/**
 * Locate the candidate the AUDN decision is targeting. Falls back to the
 * top-ranked candidate when the decision does not pin one. Exported so
 * other conflict-policy predicates that need the same lookup can share.
 */
export function resolveDecisionTarget<C extends { id: string }>(
  decision: AUDNDecision,
  candidates: C[],
): C | null {
  if (decision.targetMemoryId) {
    return candidates.find((candidate) => candidate.id === decision.targetMemoryId) ?? null;
  }
  return candidates[0] ?? null;
}

/** Reject UPDATE if merged content would grow more than 50% vs original. */
function isContentGrowthExcessive(updatedContent: string | null, originalContent: string): boolean {
  if (!updatedContent) return false;
  return updatedContent.length > originalContent.length * MAX_UPDATE_GROWTH_RATIO;
}

function isSafeReuse(candidate: CandidateSubset, factText: string, factKeywords: string[]): boolean {
  if (candidate.similarity < SAFE_REUSE_MIN_SIMILARITY) return false;
  const sharedFactKeywords = countSharedFactKeywords(factKeywords, candidate.content);
  if (sharedFactKeywords >= SAFE_REUSE_MIN_SHARED_KEYWORDS) return true;
  return sharedFactKeywords === 1
    && candidate.similarity >= SAFE_REUSE_HIGH_SIMILARITY
    && countSharedKeywords(factText, candidate.content) >= SAFE_REUSE_MIN_SHARED_KEYWORDS;
}

function countSharedKeywords(left: string, right: string): number {
  const leftWords = new Set(extractConflictKeywords(left));
  return extractConflictKeywords(right).filter((word) => leftWords.has(word)).length;
}

function countSharedFactKeywords(keywords: string[], content: string): number {
  const lowerContent = content.toLowerCase();
  return keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0)
    .filter((keyword) => lowerContent.includes(keyword))
    .length;
}

function shouldPreserveAtomicBoundary(_factText: string, _factType: string | null): boolean {
  // Apply atomic boundary protection to ALL fact types.
  // Previously gated to factType==='project' and recommendation facts only,
  // which allowed non-project facts to be merged via UPDATE/NOOP without
  // the similarity+keyword safety check. This caused 21-vs-51 memory count
  // swings across runs (AUDN non-determinism in merge decisions).
  return true;
}
