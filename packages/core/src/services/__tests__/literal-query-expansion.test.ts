/**
 * Unit tests for literal-detail query expansion.
 * Covers exact-detail queries that need lexical anchors more than semantic paraphrase.
 */

import { describe, expect, it } from 'vitest';
import {
  expandLiteralQuery,
  extractLiteralQueryKeywords,
  isLiteralDetailQuery,
} from '../literal-query-expansion.js';

describe('isLiteralDetailQuery', () => {
  it('detects direct lookup questions about literal memory details', () => {
    expect(isLiteralDetailQuery("What did the posters at the poetry reading say?")).toBe(true);
    expect(isLiteralDetailQuery("What was Melanie's favorite book from her childhood?")).toBe(true);
  });

  it('does not treat abstract symbolism questions as literal lookups', () => {
    expect(isLiteralDetailQuery("What does Caroline's drawing symbolize for her?")).toBe(false);
    expect(isLiteralDetailQuery('Why did Caroline choose the adoption agency?')).toBe(false);
  });
});

describe('extractLiteralQueryKeywords', () => {
  it('keeps concrete noun phrases for literal lookups', () => {
    const keywords = extractLiteralQueryKeywords(
      "What was Melanie's favorite book from her childhood?",
    );

    expect(keywords).toContain("Melanie's favorite book");
    expect(keywords).toContain('book');
  });

  it('keeps quoted and named anchors for object-detail questions', () => {
    const keywords = extractLiteralQueryKeywords(
      'What did Caroline take away from "Becoming Nicole"?',
    );

    expect(keywords).toContain('Becoming Nicole');
  });
});

describe('expandLiteralQuery', () => {
  it('boosts exact keyword-hit memories so they survive later reranking', async () => {
    const memory = {
      id: 'm1',
      user_id: 'u',
      content: "As of July 6 2023, Melanie's favorite childhood book was 'Charlotte's Web'.",
      embedding: [],
      memory_type: 'fact',
      importance: 0.6,
      source_site: 'test',
      source_url: '',
      episode_id: null,
      status: 'active' as const,
      metadata: {},
      keywords: '',
      namespace: null,
      summary: '',
      overview: '',
      trust_score: 1,
      created_at: new Date('2023-07-06T00:00:00Z'),
      last_accessed_at: new Date('2023-07-06T00:00:00Z'),
      access_count: 0,
      expired_at: null,
      deleted_at: null,
      network: 'experience',
      opinion_confidence: null,
      observation_subject: null,
      similarity: 0.22,
      score: 0.31,
    };
    const repo = {
      findKeywordCandidates: async () => [{ id: 'm1', similarity: 0.88, content: memory.content }],
      fetchMemoriesByIds: async () => [memory],
    };

    const result = await expandLiteralQuery(
      repo as any,
      'u',
      "What was Melanie's favorite book from her childhood?",
      [],
      new Set<string>(),
      8,
    );

    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.similarity).toBe(0.88);
    expect(result.memories[0]?.score).toBeGreaterThan(0.9);
  });
});
