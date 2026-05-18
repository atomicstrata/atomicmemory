/**
 * Conciseness preference for retrieval results.
 *
 * Penalizes over-broad composite memories when they compete with concise
 * atomic facts for narrow queries. Without this, a composite that happens
 * to contain the answer (among many irrelevant facts) can outrank a focused
 * atomic fact because its centroid embedding is generically close to many
 * query types.
 *
 * The penalty is proportional to how much longer a result is compared to the
 * median result length. Results at or below median get no penalty.
 */

import type { SearchResult } from '../db/memory-repository.js';

/**
 * Maximum penalty applied to the longest result relative to median.
 * A 0.15 penalty means a 5-point result becomes 4.25 at most.
 * Tuned to demote broad composites without destroying their ranking
 * when they genuinely contain the best answer.
 */
const MAX_PENALTY_FRACTION = 0.15;

/**
 * Results shorter than this get no penalty regardless of median.
 * Prevents penalizing normal-length memories.
 */
const PENALTY_FREE_THRESHOLD_CHARS = 150;

export function applyConcisenessPenalty(results: SearchResult[]): SearchResult[] {
  if (results.length < 2) return results;

  const lengths = results.map((r) => r.content.length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];

  if (median === 0) return results;

  return results.map((result) => {
    const len = result.content.length;
    if (len <= PENALTY_FREE_THRESHOLD_CHARS || len <= median) {
      return result;
    }

    const excessRatio = (len - median) / median;
    const penalty = Math.min(excessRatio * 0.1, MAX_PENALTY_FRACTION);
    const penalizedScore = result.score * (1 - penalty);

    return { ...result, score: penalizedScore };
  }).sort((a, b) => b.score - a.score);
}
