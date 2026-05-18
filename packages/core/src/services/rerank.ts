/**
 * Cross-encoder reranker for search-pipeline RRF results.
 *
 * Re-scores the top-N candidates from the fused RRF output by asking an LLM
 * to rate (query, candidate) relevance, then promotes the top-K. Mirrors the
 * primitive Hindsight uses but at AM's latency tier (~50-150 ms added p95).
 *
 * Principled, no-regex: an LLM-learned scoring function. No query-text pattern
 * matching. The reranker activates uniformly for all queries when the config
 * flag is on.
 *
 * Feature flag: rerankerEnabled (default OFF).
 *
 * See benchmarks-sprint3/2026-05-10-am-baseline-and-rerank-design.md.
 */

import type { ChatMessage, LLMProvider } from './llm.js';
import { llm as defaultLlm } from './llm.js';
import { extractFirstJsonObject } from './extraction.js';
import type { SearchResult } from '../db/repository-types.js';

const RERANK_MAX_TOKENS = 512;
const RERANK_DEFAULT_TOP_N = 20;
const RERANK_CANDIDATE_CONTENT_CHARS = 600;

const RERANK_SYSTEM_PROMPT = [
  'You score memory snippets by how well each one helps answer the user query.',
  '',
  'Rules:',
  '- Read the query and each candidate carefully.',
  '- For each candidate, return a relevance score in [0, 1] where:',
  '    1.0 = directly answers the query',
  '    0.5 = related but does not answer directly',
  '    0.0 = unrelated',
  '- Output a JSON object: {"scores": [s0, s1, s2, ...]} in candidate order.',
  '- Do NOT include text outside the JSON. No markdown fences.',
].join('\n');

export class RerankerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RerankerError';
  }
}

interface RawRerankResponse {
  scores?: unknown;
}

/**
 * Rerank a list of search results by LLM-judged relevance to the query.
 *
 * Returns a new array sorted by reranker score (descending). Original
 * SearchResult fields are preserved; the returned array preserves length
 * (no candidates dropped).
 *
 * Fail-closed: throws RerankerError on LLM failure or invalid output.
 * Caller is expected to catch and fall back to the un-reranked list.
 */
export async function llmRerank(
  query: string,
  candidates: SearchResult[],
  llmClient: LLMProvider = defaultLlm,
): Promise<SearchResult[]> {
  if (candidates.length === 0) return candidates;
  const limit = Math.min(candidates.length, RERANK_DEFAULT_TOP_N);
  const slice = candidates.slice(0, limit);
  const messages: ChatMessage[] = [
    { role: 'system', content: RERANK_SYSTEM_PROMPT },
    { role: 'user', content: buildRerankUserMessage(query, slice) },
  ];
  let raw: string;
  try {
    raw = await llmClient.chat(messages, {
      temperature: 0,
      jsonMode: true,
      maxTokens: RERANK_MAX_TOKENS,
    });
  } catch (err) {
    throw new RerankerError(`reranker LLM call failed: ${(err as Error).message}`, err);
  }
  if (!raw) throw new RerankerError('reranker returned empty content');
  const cleaned = extractFirstJsonObject(raw);
  let parsed: RawRerankResponse;
  try {
    parsed = JSON.parse(cleaned) as RawRerankResponse;
  } catch (err) {
    throw new RerankerError(`reranker returned non-JSON: ${cleaned.slice(0, 200)}`, err);
  }
  const scores = validateScores(parsed.scores, slice.length);
  return applyScores(slice, scores, candidates.slice(limit));
}

function buildRerankUserMessage(query: string, candidates: SearchResult[]): string {
  const blocks = candidates.map((c, i) => {
    const content = (c.content ?? '').trim().slice(0, RERANK_CANDIDATE_CONTENT_CHARS);
    return `[${i}] ${content}`;
  });
  return [
    'QUERY:',
    query.trim().slice(0, 2000),
    '',
    `CANDIDATES (${candidates.length}):`,
    blocks.join('\n'),
    '',
    `Return JSON: {"scores": [${candidates.map(() => 's').join(', ')}]} where each s is in [0, 1].`,
  ].join('\n');
}

function validateScores(raw: unknown, expectedLength: number): number[] {
  if (!Array.isArray(raw)) {
    throw new RerankerError(`scores must be an array, got ${typeof raw}`);
  }
  if (raw.length !== expectedLength) {
    throw new RerankerError(
      `scores length ${raw.length} != expected ${expectedLength}`,
    );
  }
  return raw.map((s, i) => {
    const n = typeof s === 'number' ? s : Number(s);
    if (!Number.isFinite(n)) {
      throw new RerankerError(`score[${i}] is not a finite number: ${String(s)}`);
    }
    return Math.max(0, Math.min(1, n));
  });
}

function applyScores(
  scored: SearchResult[],
  scores: number[],
  unscored: SearchResult[],
): SearchResult[] {
  const indexed = scored.map((c, i) => ({ result: c, score: scores[i]! }));
  indexed.sort((a, b) => b.score - a.score);
  return [...indexed.map((x) => x.result), ...unscored];
}
