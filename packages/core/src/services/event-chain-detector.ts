/**
 * Event-chain detector — finds per-entity chronological sequences in a set
 * of retrieved memories.
 *
 * Replaces the TLL invocation regex. Rather than guess from query phrasing
 * whether ordering matters, this module inspects the retrieved data: if 3+
 * memories share an entity AND span 3+ distinct observed_at dates AND
 * exhibit state-change between them, that's a chain worth emitting.
 *
 * Decisions are data-driven; no prompt regex.
 */

export interface ChainMember {
  memoryId: string;
  observedAt: Date;
  text: string;
}

export interface EventChain {
  entity: string;
  /** Members sorted ascending by observedAt. */
  members: ChainMember[];
  /**
   * Score reflecting confidence the chain is meaningful for ordering questions.
   * Higher = more confident. Computed from #members × distinct-date-count × 1.0.
   */
  score: number;
}

export interface ChainDetectorCandidate {
  id: string;
  text: string;
  observedAt: Date;
  /** Primary entity key; when provided, used directly for grouping. */
  entityIds?: string[];
}

export interface ChainDetectorInput {
  /** The retrieved memories from RRF + reranking. Order does not matter. */
  candidates: ReadonlyArray<ChainDetectorCandidate>;
  /** Minimum members to qualify as a chain. Recommended default: 3. */
  minMembers: number;
  /** Minimum number of distinct observed_at dates among members. Recommended default: 3. */
  minDistinctDates: number;
}

export interface ChainDetectorResult {
  /** Event chains sorted descending by score. */
  chains: EventChain[];
}

/** Minimum score a candidate chain must reach to be emitted. */
const CHAIN_SCORE_FLOOR = 9;

/**
 * Extract a fallback grouping key from memory text when entityIds is absent.
 * Takes the first non-stopword token from the text, normalized to lowercase.
 * Crude but avoids an LLM call — keeps this module synchronous and zero-latency.
 */
function extractFallbackEntityKey(text: string): string {
  const stopwords = new Set([
    'the', 'a', 'an', 'i', 'my', 'your', 'user', 'is', 'was', 'has', 'have',
    'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'it', 'this', 'that',
  ]);
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  const meaningful = tokens.find((t) => t.length >= 3 && !stopwords.has(t));
  return meaningful ?? '__unknown__';
}

/** Derive a stable entity key from a candidate. */
function entityKey(candidate: ChainDetectorCandidate): string {
  if (candidate.entityIds && candidate.entityIds.length > 0) {
    return candidate.entityIds[0];
  }
  return extractFallbackEntityKey(candidate.text);
}

/** Count the number of distinct calendar-day strings in a set of dates. */
function countDistinctDates(dates: Date[]): number {
  return new Set(dates.map((d) => d.toISOString().slice(0, 10))).size;
}

/** Build one EventChain from a validated group of candidates. */
function buildChain(entity: string, group: ChainDetectorCandidate[]): EventChain {
  const sorted = [...group].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const distinctDates = countDistinctDates(sorted.map((c) => c.observedAt));
  const score = sorted.length * distinctDates;
  const members: ChainMember[] = sorted.map((c) => ({
    memoryId: c.id,
    observedAt: c.observedAt,
    text: c.text,
  }));
  return { entity, members, score };
}

/**
 * Detect per-entity chronological event chains in a retrieved candidate set.
 *
 * Returns chains sorted descending by score. Chains below CHAIN_SCORE_FLOOR
 * or with fewer than minMembers / minDistinctDates are excluded.
 */
export function detectEventChains(input: ChainDetectorInput): ChainDetectorResult {
  const { candidates, minMembers, minDistinctDates } = input;
  if (candidates.length === 0) return { chains: [] };

  // Group candidates by entity key
  const groups = new Map<string, ChainDetectorCandidate[]>();
  for (const candidate of candidates) {
    const key = entityKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candidate);
  }

  const chains: EventChain[] = [];
  for (const [entity, group] of groups) {
    if (group.length < minMembers) continue;
    const distinctDates = countDistinctDates(group.map((c) => c.observedAt));
    if (distinctDates < minDistinctDates) continue;
    const chain = buildChain(entity, group);
    if (chain.score < CHAIN_SCORE_FLOOR) continue;
    chains.push(chain);
  }

  chains.sort((a, b) => b.score - a.score);
  return { chains };
}
