/**
 * Direct pgvector smoke test — no OpenAI needed.
 * Inserts random vectors and verifies similarity search works.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMemoryTestContext } from './test-fixtures.js';
import { pool } from '../pool.js';
import { unitVector } from './test-fixtures.js';
import { config } from '../../config.js';

const TEST_USER = 'test-user-1';

/** Make a vector close to another by adding small noise. */
function similarTo(base: number[], noise: number): number[] {
  const vec = base.map((v) => v + (Math.random() - 0.5) * noise);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / norm);
}

function vectorWithCosine(base: number[], cosine: number): number[] {
  const axisIndex = Math.abs(base[0]) < 0.9 ? 0 : 1;
  const orthogonal = base.map((value, index) => (index === axisIndex ? 1 : 0) - base[axisIndex] * value);
  const orthogonalNorm = Math.sqrt(orthogonal.reduce((sum, value) => sum + value * value, 0));
  const orthogonalUnit = orthogonal.map((value) => value / orthogonalNorm);
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return base.map((value, index) => cosine * value + sine * orthogonalUnit[index]);
}

/**
 * Run `fn` with `config.retrievalProfileSettings.rankingMinSimilarity`
 * pinned to `value`, restoring the prior value in a finally so a failing
 * assertion can't leak the test-only floor into sibling tests.
 */
async function withRankingMinSimilarity(value: number, fn: () => Promise<void>): Promise<void> {
  const previous = config.retrievalProfileSettings.rankingMinSimilarity;
  config.retrievalProfileSettings.rankingMinSimilarity = value;
  try {
    await fn();
  } finally {
    config.retrievalProfileSettings.rankingMinSimilarity = previous;
  }
}

/**
 * Pin the three distinct-score-semantics invariants for a noisy match:
 * raw `score` > `ranking_score`, and `semantic_similarity` / `relevance`
 * both equal `similarity`. Used wherever a search variant exercises the
 * "high-importance unrelated note" rescue-prevention path.
 */
function expectNoisyMatchScoreSemantics(match: {
  similarity: number;
  score: number;
  ranking_score?: number | null;
  semantic_similarity?: number;
  relevance?: number;
}): void {
  expect(match.score).toBeGreaterThan(match.ranking_score ?? Number.NaN);
  expect(match.semantic_similarity ?? Number.NaN).toBeCloseTo(match.similarity, 5);
  expect(match.relevance ?? Number.NaN).toBeCloseTo(match.similarity, 5);
}

describe('pgvector smoke test', () => {
  const { repo } = createMemoryTestContext(pool, { beforeAll, beforeEach, afterAll });

  it('stores and retrieves a memory', async () => {
    const embedding = unitVector(42);
    const id = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers dark mode',
      embedding,
      importance: 0.8,
      sourceSite: 'test',
    });

    const memory = await repo.getMemory(id);
    expect(memory).not.toBeNull();
    expect(memory!.content).toBe('User prefers dark mode');
    expect(memory!.importance).toBeCloseTo(0.8);
    expect(memory!.user_id).toBe(TEST_USER);
  });

  it('finds similar vectors with scored search', async () => {
    const baseVec = unitVector(1);
    const similarVec = similarTo(baseVec, 0.1);
    const differentVec = unitVector(999);

    await repo.storeMemory({ userId: TEST_USER, content: 'similar to query', embedding: similarVec, importance: 0.7, sourceSite: 'test' });
    await repo.storeMemory({ userId: TEST_USER, content: 'completely different', embedding: differentVec, importance: 0.5, sourceSite: 'test' });

    const results = await repo.searchSimilar(TEST_USER, baseVec, 5);
    expect(results.length).toBe(2);
    expect(results[0].content).toBe('similar to query');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('does not let high importance rescue a sub-floor vector match', async () => {
    await withRankingMinSimilarity(0.3, async () => {
      const queryVec = unitVector(123);
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'semantic match with low importance',
        embedding: vectorWithCosine(queryVec, 0.35),
        importance: 0,
        sourceSite: 'test',
      });
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'important unrelated note',
        embedding: vectorWithCosine(queryVec, 0.2),
        importance: 1,
        sourceSite: 'test',
      });

      const results = await repo.searchSimilar(TEST_USER, queryVec, 5);
      const semanticMatch = results.find((result) => result.content === 'semantic match with low importance');
      const noisyMatch = results.find((result) => result.content === 'important unrelated note');

      expect(semanticMatch).toBeDefined();
      expect(noisyMatch).toBeDefined();
      expect(results[0].content).toBe('semantic match with low importance');
      const noisyRankingScore = noisyMatch!.ranking_score ?? Number.NaN;
      const semanticRankingScore = semanticMatch!.ranking_score ?? Number.NaN;
      expect(noisyMatch!.similarity).toBeLessThan(0.3);
      expect(noisyRankingScore).toBeCloseTo(config.scoringWeightSimilarity * noisyMatch!.similarity, 5);
      expect(semanticRankingScore).toBeGreaterThan(noisyRankingScore);
      expectNoisyMatchScoreSemantics(noisyMatch!);
    });
  });

  it('populates distinct score semantics for hybrid search', async () => {
    await withRankingMinSimilarity(0.3, async () => {
      const queryVec = unitVector(456);
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'hybrid semantic match with low importance',
        embedding: vectorWithCosine(queryVec, 0.35),
        importance: 0,
        sourceSite: 'test',
      });
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'hybrid important unrelated note',
        embedding: vectorWithCosine(queryVec, 0.2),
        importance: 1,
        sourceSite: 'test',
      });

      const results = await repo.searchHybrid(TEST_USER, 'hybrid note', queryVec, 5);
      const noisyMatch = results.find((result) => result.content === 'hybrid important unrelated note');

      expect(noisyMatch).toBeDefined();
      expectNoisyMatchScoreSemantics(noisyMatch!);
    });
  });

  it('populates distinct score semantics for workspace search', async () => {
    await withRankingMinSimilarity(0.3, async () => {
      const queryVec = unitVector(789);
      const workspaceId = '00000000-0000-4000-8000-000000000789';
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'workspace semantic match with low importance',
        embedding: vectorWithCosine(queryVec, 0.35),
        importance: 0,
        sourceSite: 'test',
        workspaceId,
      });
      await repo.storeMemory({
        userId: TEST_USER,
        content: 'workspace important unrelated note',
        embedding: vectorWithCosine(queryVec, 0.2),
        importance: 1,
        sourceSite: 'test',
        workspaceId,
      });

      const results = await repo.searchSimilarInWorkspace(workspaceId, queryVec, 5);
      const semanticMatch = results.find((result) => result.content === 'workspace semantic match with low importance');
      const noisyMatch = results.find((result) => result.content === 'workspace important unrelated note');

      expect(results[0].content).toBe('workspace semantic match with low importance');
      expect(semanticMatch?.ranking_score).toBeGreaterThan(noisyMatch?.ranking_score ?? Number.NaN);
      expectNoisyMatchScoreSemantics(noisyMatch!);
    });
  });

  it('isolates memories by user_id', async () => {
    const vec = unitVector(10);
    await repo.storeMemory({ userId: 'user-a', content: 'from user A', embedding: vec, importance: 0.5, sourceSite: 'test' });
    await repo.storeMemory({ userId: 'user-b', content: 'from user B', embedding: similarTo(vec, 0.1), importance: 0.5, sourceSite: 'test' });

    const resultsA = await repo.searchSimilar('user-a', vec, 10);
    expect(resultsA.length).toBe(1);
    expect(resultsA[0].content).toBe('from user A');

    const resultsB = await repo.searchSimilar('user-b', vec, 10);
    expect(resultsB.length).toBe(1);
    expect(resultsB[0].content).toBe('from user B');
  });

  it('filters by source_site within user', async () => {
    const vec = unitVector(10);
    await repo.storeMemory({ userId: TEST_USER, content: 'from claude', embedding: vec, importance: 0.5, sourceSite: 'claude.ai' });
    await repo.storeMemory({ userId: TEST_USER, content: 'from chatgpt', embedding: similarTo(vec, 0.1), importance: 0.5, sourceSite: 'chatgpt.com' });

    const claudeResults = await repo.searchSimilar(TEST_USER, vec, 10, 'claude.ai');
    expect(claudeResults.length).toBe(1);
    expect(claudeResults[0].content).toBe('from claude');
  });

  it('stores and retrieves episodes with user_id', async () => {
    const id = await repo.storeEpisode({
      userId: TEST_USER,
      content: 'user: hello\nassistant: hi',
      sourceSite: 'test',
      sessionId: 'session-1',
    });

    const episode = await repo.getEpisode(id);
    expect(episode).not.toBeNull();
    expect(episode!.content).toContain('hello');
    expect(episode!.user_id).toBe(TEST_USER);
  });

  it('updates access count on touch', async () => {
    const vec = unitVector(77);
    const id = await repo.storeMemory({ userId: TEST_USER, content: 'test', embedding: vec, importance: 0.5, sourceSite: 'test' });

    await repo.touchMemory(id);
    await repo.touchMemory(id);

    const memory = await repo.getMemory(id);
    expect(memory!.access_count).toBe(2);
  });

  it('clamps importance to [0, 1]', async () => {
    const vec = unitVector(88);
    const id = await repo.storeMemory({ userId: TEST_USER, content: 'clamped', embedding: vec, importance: 1.5, sourceSite: 'test' });
    const memory = await repo.getMemory(id);
    expect(memory!.importance).toBeLessThanOrEqual(1.0);
  });

  it('counts memories by user', async () => {
    const vec = unitVector(50);
    await repo.storeMemory({ userId: 'counter-user', content: 'a', embedding: vec, importance: 0.5, sourceSite: 'test' });
    await repo.storeMemory({ userId: 'counter-user', content: 'b', embedding: unitVector(51), importance: 0.5, sourceSite: 'test' });
    await repo.storeMemory({ userId: 'other-user', content: 'c', embedding: unitVector(52), importance: 0.5, sourceSite: 'test' });

    const count = await repo.countMemories('counter-user');
    expect(count).toBe(2);
  });
});
