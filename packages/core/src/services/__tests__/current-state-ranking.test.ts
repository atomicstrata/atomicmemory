/**
 * Unit tests for present-state reranking on current-state queries.
 *
 * Tests cover:
 * 1. Basic current-state boosting
 * 2. Historical query detection
 * 3. Temporal demo regression: score-adjusted ordering must survive
 *    downstream stages (MMR, flat packaging, final sort)
 */

import { describe, expect, it } from 'vitest';
import {
  applyCurrentStateRanking,
  isCurrentStateQuery,
  isHistoricalQuery,
} from '../current-state-ranking.js';
import { applyMMR } from '../../db/mmr.js';

describe('applyCurrentStateRanking', () => {
  it('boosts newer current-state memories above stale alternatives', () => {
    const older = makeResult(
      'old',
      'As of January 2026, user is using Mem0 as the memory backend for their project.',
      0.99,
      '2026-01-10T00:00:00.000Z',
    );
    const newer = makeResult(
      'new',
      "As of March 2026, user's current memory backend is the internal AtomicMemory engine.",
      0.86,
      '2026-03-10T00:00:00.000Z',
    );

    const ranked = applyCurrentStateRanking(
      'What memory system does the project use?',
      [older, newer],
    );

    expect(ranked.triggered).toBe(true);
    expect(ranked.results[0]?.id).toBe('new');
  });

  it('triggers historical ranking for explicit historical queries', () => {
    const result = applyCurrentStateRanking(
      'What was the user using before switching?',
      [makeResult('old', 'User used Mem0 before switching.', 0.9, '2026-01-10T00:00:00.000Z')],
    );

    // Historical queries now trigger historical ranking (inverse of current-state)
    expect(result.triggered).toBe(true);
  });
});

describe('isCurrentStateQuery', () => {
  it('detects "now" marker', () => {
    expect(isCurrentStateQuery('What is the user using now for browser memory?')).toBe(true);
  });

  it('detects "currently" marker', () => {
    expect(isCurrentStateQuery('What backend does the user currently want?')).toBe(true);
  });

  it('rejects historical queries even with current domain markers', () => {
    expect(isCurrentStateQuery('What was the user using before switching?')).toBe(false);
  });

  it('detects quantity starters as current-state', () => {
    expect(isCurrentStateQuery('How often do I attend yoga classes?')).toBe(true);
    expect(isCurrentStateQuery('How many Korean restaurants have I tried?')).toBe(true);
    expect(isCurrentStateQuery('How long have I been using my Fitbit?')).toBe(true);
    expect(isCurrentStateQuery('How much weight have I lost so far?')).toBe(true);
  });

  it('rejects temporal comparison quantity queries', () => {
    expect(isCurrentStateQuery(
      "How many months lapsed between Avery's first and second maintenance appointment?",
    )).toBe(false);
    expect(isCurrentStateQuery(
      'How long did Alex and Jordan collaborate before launching?',
    )).toBe(false);
  });

  it('blocks quantity starters that contain historical markers', () => {
    expect(isCurrentStateQuery('How many things did I previously own?')).toBe(false);
    expect(isCurrentStateQuery('How often did I used to run?')).toBe(false);
  });
});

describe('isHistoricalQuery', () => {
  it('detects "earlier" marker', () => {
    expect(isHistoricalQuery('What earlier backend idea was corrected?')).toBe(true);
  });

  it('detects "before switching" marker', () => {
    expect(isHistoricalQuery('What was the user using before switching?')).toBe(true);
  });

  it('rejects current-state queries', () => {
    expect(isHistoricalQuery('What is the user using now?')).toBe(false);
  });
});

describe('temporal demo ordering regression', () => {
  /**
   * Reproduces the exact bug Ethan observed in the temporal demo:
   *
   * The query "What is the user using now for browser memory?" should
   * return the current AtomicMemory memory as the top result. But similarity-
   * first ordering placed stale Mem0 memories (high cosine similarity)
   * above the boosted AtomicMemory memories (high adjusted score).
   *
   * Root cause: MMR was using candidate.similarity instead of
   * candidate.score, discarding all current-state ranking adjustments.
   */
  it('current-state ranking + MMR preserves score-boosted ordering', () => {
    const query = 'What is the user using now for browser memory?';
    expect(isCurrentStateQuery(query)).toBe(true);

    // Simulate the temporal demo memories in similarity-descending order
    // (as they arrive from vector search)
    const memories = [
      makeResultWithSimilarity(
        'mem0-old',
        'User was using Mem0 for browser memory experiments in May 2024',
        0.817, 3.491,
        '2026-03-01T00:00:00.000Z',
        [0.9, 0.1, 0.05],
      ),
      makeResultWithSimilarity(
        'mem0-detail',
        'Last month I was using Mem0 for browser memory experiments.',
        0.772, 3.859,
        '2026-03-05T00:00:00.000Z',
        [0.85, 0.15, 0.08],
      ),
      makeResultWithSimilarity(
        'atomicmem-switch',
        'As of this week, user switched to the internal AtomicMemory engine for memory management.',
        0.666, 4.060,
        '2026-03-20T00:00:00.000Z',
        [0.6, 0.5, 0.4],
      ),
      makeResultWithSimilarity(
        'atomicmem-current',
        'This week I switched to the internal AtomicMemory engine.',
        0.508, 3.801,
        '2026-03-22T00:00:00.000Z',
        [0.5, 0.6, 0.3],
      ),
    ];

    // Step 1: Apply current-state ranking (boosts newer, penalizes older)
    const ranked = applyCurrentStateRanking(query, memories);
    expect(ranked.triggered).toBe(true);

    // After current-state ranking, AtomicMemory memories must have higher scores
    const atomicmemResults = ranked.results.filter((r) => r.id.startsWith('atomicmem'));
    const mem0Results = ranked.results.filter((r) => r.id.startsWith('mem0'));
    const topAtomicmemoryScore = Math.max(...atomicmemResults.map((r) => r.score));
    const topMem0Score = Math.max(...mem0Results.map((r) => r.score));
    expect(topAtomicmemoryScore).toBeGreaterThan(topMem0Score);

    // Step 2: Apply MMR (must use adjusted scores, not raw similarity)
    const queryEmbedding = [0.7, 0.4, 0.3];
    const mmrResults = applyMMR(ranked.results, queryEmbedding, 4, 0.7);

    // The top result must be a AtomicMemory memory, not a stale Mem0 memory
    expect(mmrResults[0].id).toMatch(/^atomicmem/);

    // Step 3: Final score sort (as in memory-service.ts line 341)
    const finalResults = [...mmrResults].sort((a, b) => b.score - a.score);

    // The top result must still be a AtomicMemory memory after all stages
    expect(finalResults[0].id).toMatch(/^atomicmem/);
    // And the old Mem0 memory must not be first despite higher similarity
    expect(finalResults[0].id).not.toBe('mem0-old');
  });

  it('historical query does not boost current memories', () => {
    const query = 'What was the user using before switching?';
    expect(isHistoricalQuery(query)).toBe(true);

    const memories = [
      makeResultWithSimilarity(
        'mem0-old',
        'User was using Mem0 for browser memory experiments in May 2024',
        0.90, 4.5,
        '2026-03-01T00:00:00.000Z',
        [0.9, 0.1, 0],
      ),
      makeResultWithSimilarity(
        'atomicmem-current',
        'This week I switched to the internal AtomicMemory engine.',
        0.70, 3.5,
        '2026-03-20T00:00:00.000Z',
        [0.5, 0.6, 0.3],
      ),
    ];

    const ranked = applyCurrentStateRanking(query, memories);
    expect(ranked.triggered).toBe(true);
    // Historical query should boost the older Mem0 memory
    expect(ranked.results[0].id).toBe('mem0-old');
  });

  it('mutation correction query returns corrected fact as top result', () => {
    const query = 'What backend does the user currently want for production?';
    expect(isCurrentStateQuery(query)).toBe(true);

    const memories = [
      makeResultWithSimilarity(
        'mongodb-stale',
        'User prefers MongoDB for the production memory backend.',
        0.85, 4.0,
        '2026-03-01T00:00:00.000Z',
        [0.9, 0.1, 0],
      ),
      makeResultWithSimilarity(
        'postgres-correction',
        'User wants PostgreSQL with pgvector for the production backend, replacing the earlier MongoDB choice.',
        0.78, 3.8,
        '2026-03-15T00:00:00.000Z',
        [0.7, 0.4, 0.3],
      ),
      makeResultWithSimilarity(
        'mongodb-historical',
        'MongoDB was an earlier idea, not the final choice.',
        0.60, 2.5,
        '2026-03-15T00:00:00.000Z',
        [0.5, 0.3, 0.5],
      ),
    ];

    const ranked = applyCurrentStateRanking(query, memories);
    expect(ranked.triggered).toBe(true);

    const queryEmbedding = [0.8, 0.3, 0.2];
    const mmrResults = applyMMR(ranked.results, queryEmbedding, 3, 0.7);
    const finalResults = [...mmrResults].sort((a, b) => b.score - a.score);

    // PostgreSQL correction must be top, not stale MongoDB
    expect(finalResults[0].id).toBe('postgres-correction');
    expect(finalResults[0].content).toContain('PostgreSQL');
  });
});

import { createSearchResult } from './test-fixtures.js';

function makeResult(id: string, content: string, score: number, createdAt: string) {
  return createSearchResult({
    id, content, user_id: 'u', memory_type: 'fact', importance: 0.6, network: 'experience',
    created_at: new Date(createdAt), last_accessed_at: new Date(createdAt),
    similarity: score, score,
  });
}

function makeResultWithSimilarity(
  id: string, content: string, similarity: number, score: number, createdAt: string, embedding: number[],
) {
  return createSearchResult({
    id, content, embedding, user_id: 'u', memory_type: 'fact', importance: 0.6, network: 'experience',
    created_at: new Date(createdAt), last_accessed_at: new Date(createdAt),
    similarity, score,
  });
}
