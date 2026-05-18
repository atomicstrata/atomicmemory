/**
 * Unit tests for deterministic temporal query expansion.
 */

import { describe, expect, it } from 'vitest';
import {
  extractTemporalQueryKeywords,
  expandTemporalQuery,
  isTemporalOrderingQuery,
} from '../temporal-query-expansion.js';
import { createSearchResult } from './test-fixtures.js';

describe('isTemporalOrderingQuery', () => {
  it('detects sequencing and relative-time questions', () => {
    expect(isTemporalOrderingQuery('In what order were these changes made?')).toBe(true);
    expect(isTemporalOrderingQuery('When did the student receive career advice relative to deadlines?')).toBe(true);
    expect(isTemporalOrderingQuery('What CSS framework does the developer prefer?')).toBe(false);
  });
});

describe('extractTemporalQueryKeywords', () => {
  it('keeps exact tool/entity terms for ordering questions', () => {
    const keywords = extractTemporalQueryKeywords(
      'In what order were these changes made: tRPC migration, Plaid integration, virtualization fix?',
    );

    expect(keywords).toContain('tRPC');
    expect(keywords).toContain('Plaid');
    expect(keywords).toContain('virtualization');
    expect(keywords).not.toContain('In');
  });

  it('keeps project and person anchors for relative-time questions', () => {
    const keywords = extractTemporalQueryKeywords(
      'When did the student receive career advice from Dr. Chen relative to their application timeline?',
    );

    expect(keywords).toContain('Dr. Chen');
    expect(keywords).toContain('career advice');
    expect(keywords).toContain('application timeline');
    expect(keywords).not.toContain('When');
  });

  it('keeps paper timeline phrases for academic sequencing questions', () => {
    const keywords = extractTemporalQueryKeywords(
      "What was the timeline between the student's first paper and second submission?",
    );

    expect(keywords).toContain('first paper');
    expect(keywords).toContain('second submission');
    expect(keywords).toContain('paper');
  });
});

describe('expandTemporalQuery', () => {
  const CAREER_QUERY = 'When did the student receive career advice from Dr. Chen relative to their application timeline?';

  function makeDrChenMemory() {
    return createSearchResult({
      id: 'm1', user_id: 'u',
      content: 'As of February 15 2026, user got some career advice from Dr. Chen.',
      memory_type: 'fact', importance: 0.6, network: 'experience',
      created_at: new Date('2026-02-15T00:00:00Z'),
      last_accessed_at: new Date('2026-02-15T00:00:00Z'),
      similarity: 0.2, score: 0.3,
    });
  }

  async function runCareerExpansion(repo: Record<string, unknown>) {
    return expandTemporalQuery(
      repo as any, 'u', CAREER_QUERY, [], new Set<string>(), 8,
    );
  }

  it('boosts exact keyword-hit memories so they survive candidate pruning', async () => {
    const memory = makeDrChenMemory();
    const repo = {
      findKeywordCandidates: async () => [{ id: 'm1', similarity: 0.89, content: memory.content }],
      fetchMemoriesByIds: async () => [memory],
      findTemporalNeighbors: async () => [],
    };

    const result = await runCareerExpansion(repo);

    expect(result.memories).toHaveLength(1);
    expect(result.anchorIds).toEqual(['m1']);
    expect(result.memories[0]?.similarity).toBe(0.2);
    expect(result.memories[0]?.score).toBe(0.3);
  });

  it('dedupes duplicate keyword hits when choosing temporal anchors', async () => {
    const memory = makeDrChenMemory();
    const repo = {
      findKeywordCandidates: async () => [
        { id: 'm1', similarity: 0.89, content: 'As of February 15 2026, user got some career advice from Dr. Chen.' },
        { id: 'm2', similarity: 0.89, content: 'As of February 15 2026, user got some career advice from Dr. Chen.' },
        { id: 'm3', similarity: 0.57, content: 'As of February 1 2026, user is applying to Stanford.' },
      ],
      fetchMemoriesByIds: async () => [memory, { ...memory, id: 'm2' }, { ...memory, id: 'm3', content: 'As of February 1 2026, user is applying to Stanford.' }],
      findTemporalNeighbors: async () => [],
    };

    const result = await runCareerExpansion(repo);

    expect(result.anchorIds).toEqual(['m1', 'm3']);
  });
});
