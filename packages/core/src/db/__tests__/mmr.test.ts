/**
 * Unit tests for MMR (Maximal Marginal Relevance) reranking.
 * Verifies that MMR selects diverse results over redundant ones.
 */

import { describe, it, expect } from 'vitest';
import { applyMMR } from '../mmr.js';
import { createSearchResult } from './test-fixtures.js';

function makeResult(
  id: string,
  embedding: number[],
  similarity: number,
  score: number,
) {
  return createSearchResult({ id, content: `memory-${id}`, embedding, similarity, score, access_count: 1 });
}

describe('applyMMR', () => {
  it('returns empty array for empty input', () => {
    expect(applyMMR([], [1, 0], 5, 0.7)).toEqual([]);
  });

  it('returns single result unchanged', () => {
    const result = makeResult('a', [1, 0], 0.9, 2.5);
    const mmr = applyMMR([result], [1, 0], 5, 0.7);
    expect(mmr).toHaveLength(1);
    expect(mmr[0].id).toBe('a');
  });

  it('selects the highest-scored item first', () => {
    const candidates = [
      makeResult('low', [1, 0], 0.7, 1.5),
      makeResult('high', [0.9, 0.1], 0.95, 3.0),
    ];
    const mmr = applyMMR(candidates, [1, 0], 2, 0.7);
    expect(mmr[0].id).toBe('high');
  });

  it('penalizes redundant results, promoting diverse ones', () => {
    const queryEmb = [1, 0, 0];
    // Scores are close so diversity penalty can tip the balance
    const candidates = [
      makeResult('relevant-1', [0.99, 0.01, 0], 0.99, 2.5),
      makeResult('near-duplicate', [0.98, 0.02, 0], 0.98, 2.5),
      makeResult('diverse', [0.7, 0.7, 0.1], 0.7, 2.4),
    ];
    const mmr = applyMMR(candidates, queryEmb, 2, 0.5);
    expect(mmr[0].id).toBe('relevant-1');
    expect(mmr[1].id).toBe('diverse');
  });

  it('with lambda=1.0 behaves like pure relevance ranking', () => {
    const queryEmb = [1, 0, 0];
    const candidates = [
      makeResult('top', [0.99, 0.01, 0], 0.99, 3.0),
      makeResult('second', [0.98, 0.02, 0], 0.98, 2.9),
      makeResult('third', [0.7, 0.7, 0.1], 0.7, 2.0),
    ];
    const mmr = applyMMR(candidates, queryEmb, 3, 1.0);
    expect(mmr[0].id).toBe('top');
    expect(mmr[1].id).toBe('second');
    expect(mmr[2].id).toBe('third');
  });

  it('respects limit parameter', () => {
    const candidates = [
      makeResult('a', [1, 0], 0.9, 2.5),
      makeResult('b', [0, 1], 0.8, 2.0),
      makeResult('c', [0.5, 0.5], 0.7, 1.5),
    ];
    const mmr = applyMMR(candidates, [1, 0], 2, 0.7);
    expect(mmr).toHaveLength(2);
  });

  it('respects adjusted score over raw similarity when they disagree', () => {
    // Simulates the temporal demo bug: current-state ranking boosts a
    // low-similarity memory's score above a high-similarity stale memory.
    // MMR must use score (post-reranking), not raw similarity.
    const queryEmb = [1, 0, 0];
    const candidates = [
      // Stale Mem0 memory: high similarity (0.82), but low score after
      // current-state ranking penalizes it (3.5)
      makeResult('stale-mem0', [0.95, 0.05, 0], 0.82, 3.5),
      // Current AtomicMemory memory: lower similarity (0.67), but high score
      // after current-state ranking boosts it (6.0)
      makeResult('current-atomicmem', [0.7, 0.5, 0.2], 0.67, 6.0),
      // Another stale memory: medium similarity (0.77), medium score (3.9)
      makeResult('stale-detail', [0.85, 0.15, 0], 0.77, 3.9),
    ];

    const mmr = applyMMR(candidates, queryEmb, 3, 0.7);

    // The high-score current memory must be first, not the high-similarity stale one
    expect(mmr[0].id).toBe('current-atomicmem');
    // The stale-detail should be second (next highest score, diverse enough)
    expect(mmr[1].id).toBe('stale-detail');
  });

  it('does not revert to similarity ordering after first pick', () => {
    // With the old bug (relevance = candidate.similarity), the second pick
    // would favor high-similarity over high-score candidates. This test
    // catches that regression by using candidates where similarity and
    // score are inversely ordered.
    const queryEmb = [1, 0, 0];
    const candidates = [
      makeResult('high-sim-low-score', [0.99, 0.01, 0], 0.95, 2.0),
      makeResult('med-sim-high-score', [0.6, 0.6, 0.3], 0.60, 5.0),
      makeResult('low-sim-med-score', [0.3, 0.8, 0.2], 0.30, 3.5),
    ];

    const mmr = applyMMR(candidates, queryEmb, 3, 0.7);

    // First pick: highest score wins
    expect(mmr[0].id).toBe('med-sim-high-score');
    // Second pick: score-weighted, not similarity-weighted
    expect(mmr[1].id).toBe('low-sim-med-score');
  });
});
