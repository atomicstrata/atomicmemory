/**
 * BEAM v38: read-time temporal-state reranker.
 *
 * Adds a small additive boost to candidates with an active state
 * (`event_end IS NULL`) and a small deboost to candidates whose state
 * has been superseded (`event_end IS NOT NULL`). Pure reranking — the
 * candidate set is unchanged, never filtered. This mirrors Mem0's
 * "rerank, never filter" temporal-reasoning design principle.
 *
 * Only runs when:
 *   - `temporalStateEnabled` is true at the call site, and
 *   - the query intent is `CURRENT_STATE`.
 *
 * Memories without a `state_key` (most of the corpus, especially while
 * the layer is being adopted) are untouched.
 */

import type { SearchResult } from '../db/repository-types.js';

/**
 * Boost added to active state memories. Small enough that strong semantic
 * matches still win, large enough to flip ties between active and
 * superseded versions of the same fact.
 */
const ACTIVE_STATE_BOOST = 0.1;

/** Symmetric deboost for superseded state memories. */
const SUPERSEDED_STATE_DEBOOST = 0.1;

/**
 * Apply the additive state rerank in place. Returns a new array, sorted
 * by the post-boost score (descending), so callers can drop straight in.
 */
export function applyTemporalStateRerank(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;
  const reranked = results.map((row) => {
    const boost = computeStateBoost(row);
    if (boost === 0) return row;
    return { ...row, score: row.score + boost };
  });
  return reranked.sort((a, b) => b.score - a.score);
}

function computeStateBoost(row: SearchResult): number {
  if (!row.state_key) return 0;
  if (row.event_end === null || row.event_end === undefined) {
    return ACTIVE_STATE_BOOST;
  }
  return -SUPERSEDED_STATE_DEBOOST;
}
