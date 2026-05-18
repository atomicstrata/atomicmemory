/**
 * Query-term visibility preservation for tiered context packaging.
 *
 * Tiered loading can compress a memory to L0/L1 and hide exact words from the
 * user query. This helper upgrades only those compressed memories whose richer
 * tiers reveal missing query terms without exceeding the caller's token budget.
 *
 * Returns the (possibly upgraded) assignments AND a list of memory ids whose
 * reveal-bearing upgrade was rejected solely because of the token budget.
 * Those ids feed `meta.budget_constrained` so callers can report budget
 * pressure on visibility, separately from allocator-level pressure.
 */

import type { SearchResult } from '../db/memory-repository.js';
import type { ContextTier, TierAssignment } from './tiered-loading.js';
import { estimateTokens, getContentAtTier } from './tiered-loading.js';

const QUERY_TERM_MIN_LENGTH = 4;
const QUERY_TERM_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this',
  'recently', 'attend', 'attended', 'does', 'have', 'has', 'did',
]);

export interface VisibilityResult {
  assignments: TierAssignment[];
  /**
   * Memory ids where a query-term-revealing upgrade existed but was
   * skipped because `extra > remainingBudget`. A larger budget would
   * have made these terms visible.
   */
  budgetBlockedVisibilityIds: string[];
}

/** Upgrade compressed memories when exact query terms are otherwise hidden. */
export function preserveQueryTermVisibility(
  memories: SearchResult[],
  assignments: TierAssignment[],
  query: string,
  tokenBudget: number,
): VisibilityResult {
  const terms = extractQueryVisibilityTerms(query);
  if (terms.length === 0) return { assignments, budgetBlockedVisibilityIds: [] };

  const nextAssignments = assignments.map((assignment) => ({ ...assignment }));
  const budgetBlockedVisibilityIds: string[] = [];
  let remaining = tokenBudget - sumAssignmentTokens(nextAssignments);
  for (const memory of memories) {
    const index = nextAssignments.findIndex((assignment) => assignment.memoryId === memory.id);
    if (index === -1 || nextAssignments[index].tier === 'L2') continue;
    const decision = chooseVisibleTier(memory, nextAssignments[index], terms, remaining);
    if (decision.kind === 'no-reveal') continue;
    if (decision.kind === 'budget-blocked') {
      budgetBlockedVisibilityIds.push(memory.id);
      continue;
    }
    remaining -= decision.upgrade.estimatedTokens - nextAssignments[index].estimatedTokens;
    nextAssignments[index] = decision.upgrade;
  }
  return { assignments: nextAssignments, budgetBlockedVisibilityIds };
}

export function sumAssignmentTokens(assignments: Array<{ estimatedTokens: number }>): number {
  return assignments.reduce((sum, assignment) => sum + assignment.estimatedTokens, 0);
}

type VisibilityDecision =
  | { kind: 'no-reveal' }
  | { kind: 'budget-blocked' }
  | { kind: 'upgrade'; upgrade: TierAssignment };

interface RevealCandidate {
  tier: ContextTier;
  tokens: number;
  extra: number;
  reveals: number;
}

/**
 * Pick the affordable tier that reveals the most missing query terms.
 * Tie-break by lower extra tokens. If every revealing tier exceeds the
 * remaining budget, return `budget-blocked` so callers can flag visibility
 * pressure separately from allocator pressure.
 */
function chooseVisibleTier(
  memory: SearchResult,
  assignment: TierAssignment,
  terms: string[],
  remainingBudget: number,
): VisibilityDecision {
  const current = getContentAtTier(memory, assignment.tier).toLowerCase();
  const fullContent = memory.content.toLowerCase();
  const missingTerms = terms.filter((term) => !current.includes(term) && fullContent.includes(term));
  if (missingTerms.length === 0) return { kind: 'no-reveal' };

  const candidates = collectRevealCandidates(memory, assignment, missingTerms);
  if (candidates.length === 0) return { kind: 'no-reveal' };

  const affordable = candidates.filter((candidate) => candidate.extra <= remainingBudget);
  if (affordable.length === 0) return { kind: 'budget-blocked' };

  affordable.sort((a, b) => (b.reveals - a.reveals) || (a.extra - b.extra));
  const best = affordable[0];
  return {
    kind: 'upgrade',
    upgrade: { memoryId: memory.id, tier: best.tier, estimatedTokens: best.tokens },
  };
}

function collectRevealCandidates(
  memory: SearchResult,
  assignment: TierAssignment,
  missingTerms: string[],
): RevealCandidate[] {
  const candidates: RevealCandidate[] = [];
  for (const tier of ['L1', 'L2'] as const) {
    if (tier === assignment.tier) continue;
    const content = getContentAtTier(memory, tier).toLowerCase();
    const reveals = missingTerms.reduce((count, term) => content.includes(term) ? count + 1 : count, 0);
    if (reveals === 0) continue;
    const tokens = estimateTokens(content);
    const extra = tokens - assignment.estimatedTokens;
    // Allow zero-extra upgrades: a richer tier with the same token cost
    // is a strict win when it reveals a missing query term. Skip only
    // strict downgrades (extra < 0), which would silently shrink the
    // representation and surprise callers reading the tier label.
    if (extra < 0) continue;
    candidates.push({ tier, tokens, extra, reveals });
  }
  return candidates;
}

function extractQueryVisibilityTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= QUERY_TERM_MIN_LENGTH)
    .filter((term) => !QUERY_TERM_STOP_WORDS.has(term));
  return [...new Set(terms)];
}
