/** Bound displayed search text while preserving validated, allowlisted evidence. */
import type { RetrievalReceipt, SearchResult } from '@atomicmemory/sdk';
import type { z } from 'zod/v3';
import { hitSchema, searchOutputSchema } from './tools-output-schemas.js';

const MAX_HIT_CONTENT = 4096;
const MAX_TOTAL_CONTENT = 16384;

/** A model-facing hit. Scores retain the provider's semantics, not probabilities. */
export type MemorySearchHit = Pick<SearchResult,
  'score' | 'similarity' | 'rankingScore' | 'relevance' | 'versionId' | 'observedAt'
> & { id: string; content: string; truncated: boolean };

/** Search evidence, with explicit truncation and the original retrieval receipt. */
export interface MemorySearchOutput {
  results: MemorySearchHit[];
  truncated: boolean;
  retrieval?: RetrievalReceipt;
  cursor?: string;
}

function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const next = text.charCodeAt(max);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? max - 1 : max);
}

function projectHit(hit: z.infer<typeof hitSchema>, budget: number): MemorySearchHit {
  const content = cutText(hit.memory.content, Math.min(MAX_HIT_CONTENT, budget));
  return {
    id: hit.memory.id, content, score: hit.score,
    truncated: content.length < hit.memory.content.length,
    ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
    ...(hit.rankingScore !== undefined ? { rankingScore: hit.rankingScore } : {}),
    ...(hit.relevance !== undefined ? { relevance: hit.relevance } : {}),
    ...(hit.versionId !== undefined ? { versionId: hit.versionId } : {}),
    ...(hit.observedAt !== undefined ? { observedAt: hit.observedAt } : {}),
  };
}

/** Retain search evidence while bounding model-facing hit count and content. */
export function projectSearch(input: unknown, limit: number): MemorySearchOutput {
  const page = searchOutputSchema.parse(input);
  let remaining = MAX_TOTAL_CONTENT;
  const results = page.results.slice(0, limit).map(hit => {
    const projected = projectHit(hit, remaining);
    remaining -= projected.content.length;
    return projected;
  });
  return {
    results,
    truncated: page.results.length > results.length || results.some(hit => hit.truncated),
    ...(page.retrieval !== undefined ? { retrieval: page.retrieval } : {}),
    ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
  };
}
