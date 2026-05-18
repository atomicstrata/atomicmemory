/**
 * Tiered Context Loading (L0/L1/L2).
 *
 * Three representation tiers for each memory, inspired by OpenViking's
 * SemanticDagExecutor pattern. Token savings come from injecting the
 * cheapest tier that preserves enough signal for the model to act on.
 *
 *   L0  — Abstract/headline (~10-20 tokens). Stored in `summary`.
 *   L1  — Condensed overview (~100-200 tokens). Stored in `overview`.
 *   L2  — Full content (variable). Stored in `content`.
 *
 * Tier selection is driven by a token budget: the caller declares how
 * many tokens are available for context injection, and `assignTiers`
 * decides the best tier per memory to maximize information within budget.
 *
 * Strategy:
 *   1. Greedy L0-fit: include ranked memories at L0 only while the
 *      cumulative L0 sum fits the budget; tail that can't fit is excluded.
 *   2. Within the included set, reserve L2 for the top 1–2 results.
 *   3. Promote a bounded support slice to L1.
 *   4. Track which exclusions and demotions were budget-driven (vs
 *      quota-driven) so callers can surface `meta.budget_constrained`
 *      truthfully without resorting to heuristics.
 */

import type { SearchResult } from '../db/memory-repository.js';

export type ContextTier = 'L0' | 'L1' | 'L2';

export interface TierAssignment {
  memoryId: string;
  tier: ContextTier;
  estimatedTokens: number;
}

export interface TierBudgetResult {
  assignments: TierAssignment[];
  totalTokens: number;
  budgetUsed: number;
  /** Memories that survived L0-fit and were rendered into the package. */
  includedMemories: SearchResult[];
  /** Memories dropped because their L0 representation did not fit the budget. */
  excludedMemoryIds: string[];
  /**
   * Memories kept at a lower tier than they were eligible for, solely
   * because the budget could not afford the upgrade. Quota-only blocks
   * (e.g. MAX_L2_MEMORIES, l1Quota cap) are NOT recorded here — those
   * are packaging policy and would not relax under a larger budget.
   */
  budgetLimitedPromotionIds: string[];
}

export interface TierAssignmentOptions {
  forceRichTopHit?: boolean;
}

const TOKENS_PER_CHAR = 0.25;
const MAX_L2_MEMORIES = 2;
const L2_BUDGET_SHARE = 0.6;
const TARGET_L2_SHARE = 0.2;
const TARGET_L1_SHARE = 0.3;
type TierTokenMap = Record<ContextTier, TierAssignment>;

/**
 * Estimate token count for a string using a simple character-based heuristic.
 * Accurate enough for budget allocation (±20% vs real tokenizer).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Get the content string for a memory at the requested tier.
 * Falls through to the next available tier if the requested one is empty.
 */
export function getContentAtTier(memory: SearchResult, tier: ContextTier): string {
  if (tier === 'L0') {
    return memory.summary || truncateToHeadline(memory.content);
  }
  if (tier === 'L1') {
    if (memory.overview) return memory.overview;
    return memory.content;
  }
  return memory.content;
}

/**
 * Determine the best tier for a single memory given a remaining budget.
 * Tries L2 first, falls back to L1, then L0.
 */
export function selectTierForBudget(
  memory: SearchResult,
  remainingBudget: number,
): TierAssignment {
  const l2Tokens = estimateTokens(memory.content);
  if (l2Tokens <= remainingBudget) {
    return { memoryId: memory.id, tier: 'L2', estimatedTokens: l2Tokens };
  }

  const l1Content = memory.overview || memory.content;
  const l1Tokens = estimateTokens(l1Content);
  if (l1Tokens <= remainingBudget && memory.overview) {
    return { memoryId: memory.id, tier: 'L1', estimatedTokens: l1Tokens };
  }

  const l0Content = memory.summary || truncateToHeadline(memory.content);
  const l0Tokens = estimateTokens(l0Content);
  return { memoryId: memory.id, tier: 'L0', estimatedTokens: l0Tokens };
}

/**
 * Assign tiers to a ranked list of memories under a token budget.
 *
 * Compression-and-exclude policy:
 *   1. Greedy L0-fit: include each memory at L0 only while the L0 sum
 *      fits the budget. Tail beyond that is dropped (excludedMemoryIds).
 *   2. Reserve L2 for the top 1-2 included results.
 *   3. Promote a bounded support slice to L1.
 *   4. Track budget-driven (not quota-driven) failures to upgrade.
 */
export function assignTiers(
  memories: SearchResult[],
  tokenBudget: number,
  options: TierAssignmentOptions = {},
): TierBudgetResult {
  if (memories.length === 0) {
    return { assignments: [], totalTokens: 0, budgetUsed: 0, includedMemories: [], excludedMemoryIds: [], budgetLimitedPromotionIds: [] };
  }
  const allTierOptions = memories.map(buildTierOptions);
  const { included, includedTierOptions, excludedMemoryIds } =
    selectL0Fit(memories, allTierOptions, tokenBudget);
  if (included.length === 0) {
    return { assignments: [], totalTokens: 0, budgetUsed: 0, includedMemories: [], excludedMemoryIds, budgetLimitedPromotionIds: [] };
  }

  const assignments = includedTierOptions.map(({ L0 }) => ({ ...L0 }));
  const topSliceCount = getTopSliceCount(included.length);
  const l1Quota = getL1Quota(included.length, topSliceCount);
  const budgetLimitedPromotionIds: string[] = [];

  let remaining = tokenBudget - sumTokens(assignments);
  if (options.forceRichTopHit) {
    remaining = promoteFirstMemoryToRichContext(assignments, includedTierOptions, remaining, budgetLimitedPromotionIds);
  }
  const remainingL2Budget = Math.floor(tokenBudget * L2_BUDGET_SHARE);
  promoteTopSliceToL2(assignments, includedTierOptions, remaining, remainingL2Budget, topSliceCount, budgetLimitedPromotionIds);
  remaining = tokenBudget - sumTokens(assignments);
  promoteSupportingSliceToL1(assignments, includedTierOptions, remaining, topSliceCount, l1Quota, budgetLimitedPromotionIds);

  const totalTokens = sumTokens(assignments);
  return {
    assignments,
    totalTokens,
    budgetUsed: totalTokens,
    includedMemories: included,
    excludedMemoryIds,
    budgetLimitedPromotionIds,
  };
}

/**
 * Tail-exclude L0 selector. Walks input in rank order and includes
 * each memory while its L0 token cost fits the remaining budget. On
 * the first overflow it stops and excludes the entire remaining
 * suffix — preserving semantic priority (drop the least-relevant
 * tail, never a higher-ranked memory in favor of a smaller
 * lower-ranked one).
 */
function selectL0Fit(
  memories: SearchResult[],
  allTierOptions: TierTokenMap[],
  tokenBudget: number,
): { included: SearchResult[]; includedTierOptions: TierTokenMap[]; excludedMemoryIds: string[] } {
  const included: SearchResult[] = [];
  const includedTierOptions: TierTokenMap[] = [];
  const excludedMemoryIds: string[] = [];
  let used = 0;
  let overflowed = false;
  for (let i = 0; i < memories.length; i++) {
    if (!overflowed) {
      const l0Cost = allTierOptions[i].L0.estimatedTokens;
      if (used + l0Cost <= tokenBudget) {
        included.push(memories[i]);
        includedTierOptions.push(allTierOptions[i]);
        used += l0Cost;
        continue;
      }
      overflowed = true;
    }
    excludedMemoryIds.push(memories[i].id);
  }
  return { included, includedTierOptions, excludedMemoryIds };
}

/**
 * Build the tiered injection payload: one entry per assignment, in
 * assignment order. Driven off `assignments` (not `memories`) so
 * memories that were excluded during L0-fit do not silently
 * re-appear at L0. Throws if an assignment references a memory id
 * not present in `memories` — that signals a caller bug.
 */
export function buildTieredPayload(
  memories: SearchResult[],
  assignments: TierAssignment[],
): Array<{ id: string; tier: ContextTier; content: string }> {
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  return assignments.map((a) => {
    const memory = memoryById.get(a.memoryId);
    if (!memory) {
      throw new Error(`buildTieredPayload: assignment references missing memory id "${a.memoryId}"`);
    }
    return {
      id: a.memoryId,
      tier: a.tier,
      content: getContentAtTier(memory, a.tier),
    };
  });
}

const HEADLINE_MAX_WORDS = 10;

function truncateToHeadline(content: string): string {
  const words = content.split(/\s+/);
  if (words.length <= HEADLINE_MAX_WORDS) return content;
  return words.slice(0, HEADLINE_MAX_WORDS).join(' ') + '...';
}

function buildTierOptions(memory: SearchResult): TierTokenMap {
  return {
    L0: buildAssignment(memory, 'L0'),
    L1: buildAssignment(memory, 'L1'),
    L2: buildAssignment(memory, 'L2'),
  };
}

function buildAssignment(memory: SearchResult, tier: ContextTier): TierAssignment {
  const content = getContentAtTier(memory, tier);
  return {
    memoryId: memory.id,
    tier,
    estimatedTokens: estimateTokens(content),
  };
}

/** True iff a larger budget would have allowed `chooseRichTopHit` to upgrade. */
function richTopHitHasBudgetUpgrade(options: TierTokenMap, baseline: number): boolean {
  return options.L2.estimatedTokens > baseline || options.L1.estimatedTokens > baseline;
}

function promoteFirstMemoryToRichContext(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
  budgetBlocked: string[],
): number {
  if (assignments.length === 0) return remainingBudget;
  const baseline = assignments[0].estimatedTokens;
  const preferredUpgrade = chooseRichTopHit(tierOptions[0], remainingBudget, baseline);
  if (!preferredUpgrade) {
    if (richTopHitHasBudgetUpgrade(tierOptions[0], baseline)) {
      budgetBlocked.push(assignments[0].memoryId);
    }
    return remainingBudget;
  }
  assignments[0] = preferredUpgrade;
  return remainingBudget - (preferredUpgrade.estimatedTokens - tierOptions[0].L0.estimatedTokens);
}

function chooseRichTopHit(
  options: TierTokenMap,
  remainingBudget: number,
  baselineTokens: number,
): TierAssignment | null {
  const l2Extra = options.L2.estimatedTokens - baselineTokens;
  if (l2Extra <= remainingBudget) return options.L2;

  const l1Extra = options.L1.estimatedTokens - baselineTokens;
  if (options.L1.estimatedTokens > baselineTokens && l1Extra <= remainingBudget) {
    return options.L1;
  }
  return null;
}

function promoteTopSliceToL2(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
  remainingL2Budget: number,
  topSliceCount: number,
  budgetBlocked: string[],
): void {
  let remaining = remainingBudget;
  let remainingL2 = remainingL2Budget;
  for (let index = 0; index < topSliceCount; index++) {
    const next = tierOptions[index].L2;
    const extraTokens = next.estimatedTokens - assignments[index].estimatedTokens;
    if (extraTokens > remaining || extraTokens > remainingL2) {
      // Both bounds scale with tokenBudget (remainingL2 = floor(budget * L2_BUDGET_SHARE)),
      // so a larger budget would have permitted the upgrade. Record budget block,
      // but only if there was an actual upgrade available (extraTokens > 0).
      if (extraTokens > 0) budgetBlocked.push(assignments[index].memoryId);
      continue;
    }
    assignments[index] = next;
    remaining -= extraTokens;
    remainingL2 -= extraTokens;
  }
}

function promoteSupportingSliceToL1(
  assignments: TierAssignment[],
  tierOptions: TierTokenMap[],
  remainingBudget: number,
  topSliceCount: number,
  l1Quota: number,
  budgetBlocked: string[],
): void {
  let remaining = remainingBudget;
  const stopIndex = Math.min(assignments.length, topSliceCount + l1Quota);
  for (let index = topSliceCount; index < stopIndex; index++) {
    const next = tierOptions[index].L1;
    const extraTokens = next.estimatedTokens - assignments[index].estimatedTokens;
    // No real upgrade (no `overview`, L1 collapses to L0). Not a budget question.
    if (next.estimatedTokens === assignments[index].estimatedTokens) continue;
    if (extraTokens > remaining) {
      budgetBlocked.push(assignments[index].memoryId);
      continue;
    }
    assignments[index] = next;
    remaining -= extraTokens;
  }
}

function getTopSliceCount(totalMemories: number): number {
  if (totalMemories === 0) return 0;
  return Math.min(MAX_L2_MEMORIES, Math.max(1, Math.round(totalMemories * TARGET_L2_SHARE)));
}

function getL1Quota(totalMemories: number, topSliceCount: number): number {
  const remainingAfterTopSlice = totalMemories - topSliceCount;
  if (remainingAfterTopSlice <= 1) return Math.max(0, remainingAfterTopSlice);

  const targetL1Count = Math.max(1, Math.floor(totalMemories * TARGET_L1_SHARE));
  return Math.min(remainingAfterTopSlice - 1, targetL1Count);
}

function sumTokens(assignments: TierAssignment[]): number {
  return assignments.reduce((sum, assignment) => sum + assignment.estimatedTokens, 0);
}
