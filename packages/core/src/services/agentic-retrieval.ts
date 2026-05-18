/**
 * Agentic multi-round retrieval (EverMemOS-inspired).
 *
 * After initial retrieval, an LLM sufficiency check determines whether
 * the retrieved memories are adequate to answer the query. If not, the
 * query is decomposed into 2-3 complementary sub-queries, each retrieved
 * in parallel, and results are fused via weighted merge.
 *
 * This specifically targets multi-hop questions where a single query
 * embedding can't capture all the required facts.
 *
 * Trade-offs:
 * - Adds 1 LLM call (sufficiency check + decomposition) when triggered
 * - Adds N embedding calls for sub-queries
 * - Only fires when initial retrieval is deemed insufficient
 * - Latency: ~1-2s additional when triggered
 */

import { llm } from './llm.js';
import { embedText } from './embedding.js';
import { mergeSearchResults } from './retrieval-policy.js';
import type { CoreRuntimeConfig } from '../app/runtime-container.js';
import type { SearchResult } from '../db/repository-types.js';
import type { SearchStore } from '../db/stores.js';
import { config } from '../config.js';

const SUFFICIENCY_AND_DECOMPOSE_PROMPT = `You are a memory retrieval assistant. Given a user's question and the memories retrieved so far, determine if the memories are SUFFICIENT to answer the question fully.

RULES:
- A question is SUFFICIENT if the retrieved memories contain all the information needed for a complete answer.
- A question is INSUFFICIENT if key information is missing — especially for multi-hop questions that require connecting multiple facts.
- For simple factual questions with a direct match, mark as SUFFICIENT.
- For questions requiring temporal reasoning, relationship inference, or connecting multiple facts, be stricter about sufficiency.

If INSUFFICIENT, generate 2-3 complementary search queries that would retrieve the missing information. Each sub-query should target a DIFFERENT aspect of the original question.

Respond in JSON:
{
  "sufficient": true/false,
  "reason": "brief explanation",
  "subQueries": ["query1", "query2"]  // only if insufficient, empty if sufficient
}`;

interface SufficiencyResult {
  sufficient: boolean;
  reason: string;
  subQueries: string[];
}

type AgenticRetrievalRuntimeConfig = Pick<
  CoreRuntimeConfig,
  'hybridSearchEnabled' | 'retrievalProfileSettings' | 'maxSearchResults'
>;

/**
 * Check if retrieved memories are sufficient and decompose if not.
 * Returns null if sufficient (no additional retrieval needed).
 */
async function checkSufficiencyAndDecompose(
  query: string,
  memories: SearchResult[],
): Promise<SufficiencyResult> {
  const memorySummary = memories.length === 0
    ? 'No memories retrieved.'
    : memories
      .slice(0, 10)
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n');

  const userMessage = `Question: ${query}\n\nRetrieved memories:\n${memorySummary}`;

  const response = await llm.chat(
    [
      { role: 'system', content: SUFFICIENCY_AND_DECOMPOSE_PROMPT },
      { role: 'user', content: userMessage },
    ],
    { temperature: 0, maxTokens: 300 },
  );

  try {
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as SufficiencyResult;
    return {
      sufficient: parsed.sufficient === true,
      reason: parsed.reason ?? '',
      subQueries: Array.isArray(parsed.subQueries)
        ? parsed.subQueries.filter((q): q is string => typeof q === 'string' && q.length > 0).slice(0, 3)
        : [],
    };
  } catch {
    console.error('[agentic-retrieval] Failed to parse sufficiency response:', response.slice(0, 200));
    return { sufficient: true, reason: 'parse-error', subQueries: [] };
  }
}

/**
 * Execute sub-queries in parallel and retrieve additional memories.
 */
async function retrieveSubQueries(
  repo: SearchStore,
  userId: string,
  subQueries: string[],
  candidateDepth: number,
  policyConfig: AgenticRetrievalRuntimeConfig,
  sourceSite?: string,
  referenceTime?: Date,
): Promise<SearchResult[]> {
  const retrievalPromises = subQueries.map(async (subQuery) => {
    const embedding = await embedText(subQuery, 'query');
    if (policyConfig.hybridSearchEnabled) {
      return repo.searchHybrid(userId, subQuery, embedding, candidateDepth, sourceSite, referenceTime);
    }
    return repo.searchSimilar(userId, embedding, candidateDepth, sourceSite, referenceTime);
  });

  const results = await Promise.all(retrievalPromises);

  // Fuse all sub-query results via weighted merge
  let fused: SearchResult[] = [];
  for (const subResult of results) {
    fused = mergeSearchResults(fused, subResult, candidateDepth, policyConfig);
  }
  return fused;
}

export interface AgenticRetrievalResult {
  memories: SearchResult[];
  triggered: boolean;
  subQueries: string[];
  reason: string;
}

/**
 * Agentic multi-round retrieval: check sufficiency of initial results,
 * decompose query if insufficient, retrieve sub-queries, and fuse.
 *
 * Only fires when:
 * 1. agenticRetrievalEnabled is true in config
 * 2. Initial results have low top similarity OR few results
 * 3. The sufficiency check says memories are insufficient
 */
export async function applyAgenticRetrieval(
  repo: SearchStore,
  userId: string,
  query: string,
  initialResults: SearchResult[],
  candidateDepth: number,
  sourceSite?: string,
  referenceTime?: Date,
  policyConfig: AgenticRetrievalRuntimeConfig = config,
): Promise<AgenticRetrievalResult> {
  // Quick gate: skip for queries that already have strong results
  if (initialResults.length >= 3 && initialResults[0].similarity >= 0.85) {
    return { memories: initialResults, triggered: false, subQueries: [], reason: 'strong-initial-results' };
  }

  const sufficiency = await checkSufficiencyAndDecompose(query, initialResults);

  if (sufficiency.sufficient || sufficiency.subQueries.length === 0) {
    return {
      memories: initialResults,
      triggered: false,
      subQueries: [],
      reason: sufficiency.reason || 'sufficient',
    };
  }

  console.log(`[agentic-retrieval] Insufficient: "${sufficiency.reason}". Decomposing into ${sufficiency.subQueries.length} sub-queries`);
  for (const sq of sufficiency.subQueries) {
    console.log(`[agentic-retrieval]   → "${sq}"`);
  }

  const subQueryResults = await retrieveSubQueries(
    repo, userId, sufficiency.subQueries, candidateDepth, policyConfig, sourceSite, referenceTime,
  );

  // Merge initial + sub-query results
  const merged = mergeSearchResults(initialResults, subQueryResults, candidateDepth, policyConfig);

  console.log(`[agentic-retrieval] Merged: ${initialResults.length} initial + ${subQueryResults.length} sub-query → ${merged.length} total`);

  return {
    memories: merged,
    triggered: true,
    subQueries: sufficiency.subQueries,
    reason: sufficiency.reason,
  };
}
