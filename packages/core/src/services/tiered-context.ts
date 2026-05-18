/**
 * Tiered Context Loading — L0/L1/L2 style multi-resolution memory representations.
 *
 * Extends the existing staged loading with a proper three-tier model:
 *   - L0 (~10 words): Headline/abstract — compact preview for browsing and listing.
 *     Stored in the `summary` column, generated at extraction time.
 *   - L1 (~1-3 sentences): Overview — mid-level summary preserving key details.
 *     Generated on demand or at ingest time. Good for planning/reasoning.
 *   - L2 (full content): Complete memory content. Used for detailed drill-in.
 *
 * Token budget model:
 *   Given a total injection budget, the tier selector assigns each memory
 *   a tier based on its relevance score. High-relevance memories get L2,
 *   mid-relevance get L1, low-relevance get L0. This maximizes information
 *   density within the budget.
 *
 * Inspired by OpenViking's three-tier model (82% token reduction on LoCoMo10).
 * Phase 2 roadmap item: "Tiered context loading" (OpenViking review, 2026-03-16).
 */

import { escapeXml } from '../xml-escape.js';

/** Memory content at different resolution levels. */
export interface TieredContent {
  l0: string;
  l1: string | null;
  l2: string;
}

/** Tier assignment for a single memory in a retrieval result set. */
export interface TierAssignment {
  memoryId: string;
  tier: ContextTier;
  content: string;
  estimatedTokens: number;
}

export type ContextTier = 'L0' | 'L1' | 'L2';

/** Score thresholds for tier assignment. */
export interface TierThresholds {
  l2MinScore: number;
  l1MinScore: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  l2MinScore: 0.70,
  l1MinScore: 0.40,
};

/** Approximate token budget per tier (used for budget allocation). */
const TIER_TOKEN_ESTIMATES = {
  L0: 15,
  L1: 80,
  L2: 200,
} as const;

/** Rank-based tier counts (used with selectRanksForQuery). */
export interface TierRanks {
  l2Count: number;
  l1Count: number;
}

const DEFAULT_TIER_RANKS: TierRanks = {
  l2Count: 2,
  l1Count: 2,
};

/** Promoted ranks for multi-fact queries: all L2, no truncation. */
const PROMOTED_TIER_RANKS: TierRanks = {
  l2Count: 10,
  l1Count: 0,
};

/**
 * Multi-fact query patterns that need full context across memories.
 * These queries ask to connect, enumerate, or synthesize multiple facts.
 */
const MULTI_FACT_PATTERNS = [
  /\bconnection\b/i,
  /\brelationship\b/i,
  /\brelate\b/i,
  /\bboth\b/i,
  /\ball\b/i,
  /\bfull\b.*\b(stack|list|set|trajectory|history)\b/i,
  /\btwo\b.*\b(projects?|papers?|tools?|colleagues?)\b/i,
  /\bcompare\b/i,
  /\btogether\b/i,
  /\bin what order\b/i,
  /\bhow many\b/i,
  /\bwhat are the\b.*\band\b/i,
];

/**
 * Detect whether a query needs full content from all memories.
 * Returns promoted ranks for multi-fact queries, default ranks otherwise.
 */
function selectRanksForQuery(query: string): TierRanks {
  const needsPromotion = MULTI_FACT_PATTERNS.some((pattern) => pattern.test(query));
  return needsPromotion ? PROMOTED_TIER_RANKS : DEFAULT_TIER_RANKS;
}

/**
 * Generate an L1 overview from full content.
 * Uses a simple extractive approach: takes the first 2-3 sentences.
 * No LLM call required — deterministic and fast.
 */
export function generateL1Overview(content: string): string {
  const sentences = splitSentences(content);
  if (sentences.length <= 2) return content;

  const targetLength = 3;
  const overview = sentences.slice(0, targetLength).join(' ');

  if (overview.length > 300) {
    return sentences.slice(0, 2).join(' ');
  }
  return overview;
}

/**
 * Build tiered content from a memory's existing fields.
 * L0 = summary/headline, L1 = generated overview, L2 = full content.
 */
export function buildTieredContent(
  content: string,
  summary: string,
): TieredContent {
  const l0 = summary || truncateToHeadline(content);
  const l1 = generateL1Overview(content);
  const l1IsSameAsL2 = l1 === content;
  return {
    l0,
    l1: l1IsSameAsL2 ? null : l1,
    l2: content,
  };
}

/**
 * Assign context tiers to a set of scored memories within a token budget.
 *
 * Algorithm:
 *   1. Sort memories by score (descending).
 *   2. Greedily assign the highest affordable tier to each memory.
 *   3. If budget runs out, remaining memories get L0.
 *
 * Returns assignments in the original order.
 */
export function assignTiers(
  memories: Array<{ id: string; score: number; content: string; summary: string }>,
  tokenBudget: number,
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
): TierAssignment[] {
  if (memories.length === 0) return [];

  const indexed = memories.map((m, i) => ({ ...m, originalIndex: i }));
  indexed.sort((a, b) => b.score - a.score);

  let remainingBudget = tokenBudget;
  const assignments: Array<TierAssignment & { originalIndex: number }> = [];

  for (const memory of indexed) {
    const tiered = buildTieredContent(memory.content, memory.summary);
    const { tier, content, tokens } = selectTierForBudget(
      memory.score, tiered, remainingBudget, thresholds,
    );
    remainingBudget -= tokens;
    assignments.push({
      memoryId: memory.id,
      tier,
      content,
      estimatedTokens: tokens,
      originalIndex: memory.originalIndex,
    });
  }

  assignments.sort((a, b) => a.originalIndex - b.originalIndex);
  return assignments.map(({ originalIndex: _, ...rest }) => rest);
}

/**
 * Select the highest-quality tier that fits within the remaining budget.
 */
function selectTierForBudget(
  score: number,
  tiered: TieredContent,
  remainingBudget: number,
  thresholds: TierThresholds,
): { tier: ContextTier; content: string; tokens: number } {
  const l2Tokens = estimateTokens(tiered.l2);
  if (score >= thresholds.l2MinScore && l2Tokens <= remainingBudget) {
    return { tier: 'L2', content: tiered.l2, tokens: l2Tokens };
  }

  if (tiered.l1 !== null) {
    const l1Tokens = estimateTokens(tiered.l1);
    if (score >= thresholds.l1MinScore && l1Tokens <= remainingBudget) {
      return { tier: 'L1', content: tiered.l1, tokens: l1Tokens };
    }
  }

  const l0Tokens = estimateTokens(tiered.l0);
  return { tier: 'L0', content: tiered.l0, tokens: l0Tokens };
}

/**
 * Format tiered memory assignments into XML injection text.
 * Each memory includes its tier level so the consuming LLM knows
 * which memories have full detail vs summaries.
 */
export function formatTieredInjection(assignments: TierAssignment[]): string {
  if (assignments.length === 0) return '';

  const tierCounts = countTiers(assignments);
  const totalTokens = assignments.reduce((sum, a) => sum + a.estimatedTokens, 0);
  const expandableIds = assignments
    .filter((a) => a.tier !== 'L2')
    .map((a) => a.memoryId);

  const lines = assignments.map((a, i) => {
    const tierAttr = `tier="${a.tier}"`;
    return `<memory index="${i + 1}" memory_id="${a.memoryId}" ${tierAttr}>\n${escapeXml(a.content)}\n</memory>`;
  });

  const header = [
    `<atomicmem_context count="${assignments.length}"`,
    `mode="tiered"`,
    `tokens="~${totalTokens}"`,
    `tiers="L0:${tierCounts.L0},L1:${tierCounts.L1},L2:${tierCounts.L2}"`,
    expandableIds.length > 0 ? `expand_ids="${expandableIds.join(',')}"` : '',
  ].filter(Boolean).join(' ');

  const parts = [`${header}>`];
  parts.push(lines.join('\n'));
  if (expandableIds.length > 0) {
    parts.push('<expand_hint>Request expansion by ID for full content of L0/L1 memories.</expand_hint>');
  }
  parts.push('</atomicmem_context>');
  return parts.join('\n');
}

/**
 * Estimate token count using the ~4 chars per token heuristic.
 * Good enough for budget allocation; not meant to be exact.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Calculate token savings from tiered loading vs all-L2.
 * Returns the percentage of tokens saved.
 */
export function calculateTokenSavings(assignments: TierAssignment[], fullContentLengths: number[]): number {
  if (assignments.length === 0 || fullContentLengths.length === 0) return 0;
  const fullTokens = fullContentLengths.reduce((sum, len) => sum + estimateTokens(Array(len).fill('x').join('')), 0);
  const tieredTokens = assignments.reduce((sum, a) => sum + a.estimatedTokens, 0);
  if (fullTokens === 0) return 0;
  return ((fullTokens - tieredTokens) / fullTokens) * 100;
}

function countTiers(assignments: TierAssignment[]): Record<ContextTier, number> {
  const counts: Record<ContextTier, number> = { L0: 0, L1: 0, L2: 0 };
  for (const a of assignments) counts[a.tier]++;
  return counts;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncateToHeadline(content: string): string {
  const words = content.split(/\s+/);
  if (words.length <= 10) return content;
  return words.slice(0, 10).join(' ') + '...';
}
