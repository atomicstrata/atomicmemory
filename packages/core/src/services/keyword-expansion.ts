/**
 * Shared keyword-based expansion logic for retrieval augmentation.
 *
 * Used by literal-query-expansion.ts and subject-aware-ranking.ts to
 * eliminate duplicated fetch-and-boost patterns.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';

/** Fetch keyword candidate memories and boost their scores. */
export async function fetchAndBoostKeywordCandidates(
  repo: SearchStore,
  userId: string,
  keywords: string[],
  queryEmbedding: number[],
  excludeIds: Set<string>,
  limit: number,
  scoreBoostFactor: number,
  includeExpired = false,
): Promise<SearchResult[]> {
  const candidates = await repo.findKeywordCandidates(userId, keywords, limit, includeExpired);
  const ids = candidates
    .map((candidate) => candidate.id)
    .filter((id) => !excludeIds.has(id));
  if (ids.length === 0) return [];

  const fetched = await repo.fetchMemoriesByIds(userId, ids, queryEmbedding, undefined, includeExpired);
  return fetched.map((memory) => {
    const keywordHit = candidates.find((candidate) => candidate.id === memory.id);
    if (!keywordHit) return memory;
    return {
      ...memory,
      similarity: Math.max(memory.similarity, keywordHit.similarity),
      score: memory.score + (keywordHit.similarity * scoreBoostFactor),
    };
  });
}
