/**
 * Maximal Marginal Relevance (MMR) reranking.
 *
 * Greedily selects results that balance relevance to the query against
 * redundancy with already-selected results. This improves diversity in
 * the top-K, which is critical for multi-hop queries that need different
 * types of facts to compose a complete answer.
 *
 * score_mmr(d) = lambda * score(d) - (1 - lambda) * max(sim(d, selected_i))
 *
 * Source: Carbonell & Goldstein (1998), Phase 2 roadmap item.
 */

import type { SearchResult } from './repository-types.js';
import { cosineSimilarity } from '../vector-math.js';

export function applyMMR(
  candidates: SearchResult[],
  queryEmbedding: number[],
  limit: number,
  lambda: number,
): SearchResult[] {
  if (candidates.length <= 1) return candidates.slice(0, limit);

  const selected: SearchResult[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  const bestIndex = selectHighestScore(candidates);
  selected.push(candidates[bestIndex]);
  remaining.delete(bestIndex);

  while (selected.length < limit && remaining.size > 0) {
    const bestCandidate = selectBestMmrCandidate(candidates, selected, remaining, lambda);
    if (bestCandidate === -1) break;
    selected.push(candidates[bestCandidate]);
    remaining.delete(bestCandidate);
  }

  return selected;
}

/** Find the index of the candidate with the highest relevance score. */
function selectHighestScore(candidates: SearchResult[]): number {
  return candidates.reduce(
    (best, current, i) => (current.score > candidates[best].score ? i : best),
    0,
  );
}

/** Select the remaining candidate with the best MMR score, or -1 if none. */
function selectBestMmrCandidate(
  candidates: SearchResult[],
  selected: SearchResult[],
  remaining: Set<number>,
  lambda: number,
): number {
  let bestMmrScore = -Infinity;
  let bestCandidate = -1;

  for (const candidateIndex of remaining) {
    const mmrScore = computeMmrScore(candidates[candidateIndex], selected, lambda);
    if (mmrScore > bestMmrScore) {
      bestMmrScore = mmrScore;
      bestCandidate = candidateIndex;
    }
  }
  return bestCandidate;
}

/** Compute MMR score: balance relevance against redundancy with selected set. */
function computeMmrScore(
  candidate: SearchResult,
  selected: SearchResult[],
  lambda: number,
): number {
  let maxRedundancy = 0;
  for (const selectedResult of selected) {
    const redundancy = cosineSimilarity(candidate.embedding, selectedResult.embedding);
    if (redundancy > maxRedundancy) maxRedundancy = redundancy;
  }
  return lambda * candidate.score - (1 - lambda) * maxRedundancy;
}
