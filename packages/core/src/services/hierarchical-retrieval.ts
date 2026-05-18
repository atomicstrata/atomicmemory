/**
 * Hierarchical retrieval — the 5th RRF arm (T2.3 scaffold).
 *
 * Three-stage pipeline for BEAM-10M scale:
 *   stage 1: top-K conv_summaries by query-embedding cosine
 *   stage 2: top-K session_summaries within those conversations
 *   stage 3: expand to atomic-fact ids (memories.id) for the matched sessions
 *
 * Output ids are handed to the existing search-pipeline's RRF fusion as a 5th
 * arm. Full pipeline integration lives in T2.4 (memory-search.ts wiring); this
 * module exposes the arm as a stand-alone callable so it can be tested
 * independently and unit-mocked.
 *
 * Gated by `hierarchicalRetrievalEnabled`. With the flag off, the function
 * short-circuits and returns an empty result with zero work done — preserves
 * byte-for-byte behavior on existing deployments.
 */

import type { SummariesRepository } from '../db/summaries-repository.js';

/** Result of one hierarchical retrieval pass. */
export interface HierarchicalArmResult {
  /** Atomic memory ids surfaced by the arm. Empty when flag off / no data. */
  memoryIds: string[];
  /** Conversation ids matched at stage 1 (for trace observability). */
  matchedConvs: string[];
  /** Session ids matched at stage 2 (for trace observability). */
  matchedSessions: string[];
  /** LLM cost incurred by this arm. Always 0 today — only embedding ops. */
  cost: number;
}

export interface HierarchicalArmDeps {
  config: {
    hierarchicalRetrievalEnabled: boolean;
  };
  summariesRepo: SummariesRepository;
}

export interface HierarchicalArmOptions {
  /** Stage 1: how many conversations to surface. Default 3. */
  topConvs?: number;
  /** Stage 2: how many sessions to surface across selected convs. Default 10. */
  topSessions?: number;
  /** Stage 3: how many atomic facts to return. Default 50. */
  factLimit?: number;
}

const EMPTY: HierarchicalArmResult = {
  memoryIds: [],
  matchedConvs: [],
  matchedSessions: [],
  cost: 0,
};

/**
 * Run the hierarchical arm. Caller is responsible for embedding the query
 * (we keep this function pure — it doesn't call an embedding provider so
 * tests don't need to mock one).
 */
export async function runHierarchicalArm(
  deps: HierarchicalArmDeps,
  userId: string,
  queryEmbedding: number[],
  opts: HierarchicalArmOptions = {},
): Promise<HierarchicalArmResult> {
  if (!deps.config.hierarchicalRetrievalEnabled) {
    return EMPTY;
  }
  const topConvs = opts.topConvs ?? 3;
  const topSessions = opts.topSessions ?? 10;
  const factLimit = opts.factLimit ?? 50;

  // Stage 1
  const convHits = await deps.summariesRepo.searchTopConvSummaries(
    userId,
    queryEmbedding,
    topConvs,
  );
  if (convHits.length === 0) return EMPTY;

  // Stage 2
  const matchedConvs = convHits.map((h) => h.conversationId);
  const sessionHits = await deps.summariesRepo.searchTopSessionSummaries(
    userId,
    matchedConvs,
    queryEmbedding,
    topSessions,
  );
  if (sessionHits.length === 0) {
    return { memoryIds: [], matchedConvs, matchedSessions: [], cost: 0 };
  }

  // Stage 3
  const matchedSessions = sessionHits.map((h) => h.sessionId);
  const memoryIds = await deps.summariesRepo.getMemoryIdsForSessions(
    userId,
    matchedSessions,
    factLimit,
  );
  return { memoryIds, matchedConvs, matchedSessions, cost: 0 };
}
