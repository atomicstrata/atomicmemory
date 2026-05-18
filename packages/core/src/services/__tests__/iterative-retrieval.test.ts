/**
 * Unit tests for deterministic iterative retrieval.
 */

import { describe, expect, it } from 'vitest';
import {
  applyIterativeRetrieval,
  classifyIterativeQuery,
  selectIterativeSeeds,
} from '../iterative-retrieval.js';
import { createSearchResult } from './test-fixtures.js';

let nextResultId = 0;

function makeResult(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({ id: `mem-${nextResultId++}`, embedding: [1, 0], ...overrides });
}

describe('classifyIterativeQuery', () => {
  it('keeps simple fact queries on one pass', () => {
    const classification = classifyIterativeQuery(
      'What build tool does the developer use?',
      [makeResult(), makeResult()],
    );
    expect(classification.shouldIterate).toBe(false);
    expect(classification.reason).toBe('below-threshold');
  });

  it('flags relational multi-hop queries for a second pass', () => {
    const classification = classifyIterativeQuery(
      'What is the connection between Jake and the technology choices for the finance tracker?',
      [makeResult(), makeResult()],
    );
    expect(classification.shouldIterate).toBe(true);
    expect(classification.estimatedFactCount).toBeGreaterThanOrEqual(5);
    expect(classification.reason).toBe('relational-composition');
  });

  it('flags explicit timeline queries for a second pass', () => {
    const classification = classifyIterativeQuery(
      'In what order were these changes made: tRPC migration, Plaid integration, virtualization fix?',
      [makeResult(), makeResult()],
    );
    expect(classification.shouldIterate).toBe(true);
    expect(classification.reason).toBe('timeline-composition');
  });
});

describe('selectIterativeSeeds', () => {
  it('prefers distinct seeds with anchor overlap', () => {
    const seeds = selectIterativeSeeds([
      makeResult({ id: 'a', content: 'Jake recommended Supabase for the finance tracker', score: 0.7 }),
      makeResult({ id: 'b', content: 'Jake recommended Supabase for the finance tracker', score: 0.9 }),
      makeResult({ id: 'c', content: 'Finance tracker uses Plaid for bank sync', score: 0.8 }),
    ], ['jake', 'finance', 'tracker']);
    expect(seeds.map((seed) => seed.id)).toEqual(['b', 'c']);
  });
});

describe('applyIterativeRetrieval', () => {
  it('merges weighted second-pass neighbors for compositional queries', async () => {
    const repo = {
      searchSimilar: async () => [
        makeResult({ id: 'neighbor', content: 'Neighbor memory', score: 0.9, similarity: 0.7, embedding: [0, 1] }),
      ],
    } as unknown as { searchSimilar: (...args: unknown[]) => Promise<import('../../db/repository-types.js').SearchResult[]> };

    const result = await applyIterativeRetrieval(
      repo as never,
      'user-1',
      'What is the connection between Jake and the technology choices for the finance tracker?',
      [0.5, 0.5],
      [
        makeResult({ id: 'seed-1', content: 'Jake recommended Supabase', embedding: [1, 0] }),
        makeResult({ id: 'seed-2', content: 'Finance tracker uses Supabase', embedding: [0, 1] }),
      ],
      6,
    );

    expect(result.triggered).toBe(true);
    expect(result.memories.some((memory) => memory.id === 'neighbor')).toBe(true);
    expect(result.seedIds).toEqual(['seed-2', 'seed-1']);
  });
});
