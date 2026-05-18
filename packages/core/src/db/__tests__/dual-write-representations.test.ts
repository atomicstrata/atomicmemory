/**
 * Integration tests for dual-write child representations.
 * Validates atomic fact storage, foresight storage, and fact-level hybrid
 * retrieval that hydrates parent memory rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTestContext, unitVector, offsetVector } from './test-fixtures.js';
import { config } from '../../config.js';
import { pool } from '../pool.js';

const TEST_USER = 'dual-write-user';

function deterministicEmbedding(seed: number): number[] {
  const vec = Array.from({ length: config.embeddingDimensions }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + (value * value), 0));
  return vec.map((value) => value / norm);
}

function nearbyEmbedding(base: number[], scale: number): number[] {
  const vec = base.map((value, index) => value + (Math.cos((index + 1) * scale) * 0.01));
  const norm = Math.sqrt(vec.reduce((sum, current) => sum + (current * current), 0));
  return vec.map((value) => value / norm);
}

describe('dual-write representations', () => {
  const { repo } = createMemoryTestContext(pool, { beforeAll, beforeEach, afterAll });

  it('stores and lists atomic facts and foresight per parent memory', async () => {
    const parentEmbedding = deterministicEmbedding(2);
    const parentId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'As of March 2026, the user is using Supabase for dotctl backend work.',
      embedding: parentEmbedding,
      importance: 0.8,
      sourceSite: 'test',
      summary: 'Uses Supabase for dotctl',
      overview: 'Supabase is the backend choice for dotctl.',
    });

    await repo.storeAtomicFacts([{
      userId: TEST_USER,
      parentMemoryId: parentId,
      factText: 'As of March 2026, the user is using Supabase for the dotctl backend.',
      embedding: nearbyEmbedding(parentEmbedding, 0.3),
      factType: 'project',
      importance: 0.8,
      sourceSite: 'test',
      keywords: 'Supabase dotctl backend',
      metadata: { headline: 'Uses Supabase for dotctl' },
    }]);

    await repo.storeForesight([{
      userId: TEST_USER,
      parentMemoryId: parentId,
      content: 'The user plans to add scheduling to dotctl next week.',
      embedding: nearbyEmbedding(parentEmbedding, 0.5),
      foresightType: 'plan',
      sourceSite: 'test',
    }]);

    const facts = await repo.listAtomicFactsForMemory(TEST_USER, parentId);
    const foresight = await repo.listForesightForMemory(TEST_USER, parentId);

    expect(facts).toHaveLength(1);
    expect(facts[0].fact_text).toContain('Supabase');
    expect(foresight).toHaveLength(1);
    expect(foresight[0].content).toContain('plans to add scheduling');
  });

  it('retrieves parent memories from fact-level hybrid search', async () => {
    const relevantParentEmbedding = deterministicEmbedding(4);
    const otherParentEmbedding = deterministicEmbedding(90);
    const relevantParentId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'As of March 2026, the user is using Supabase for dotctl backend work.',
      embedding: relevantParentEmbedding,
      importance: 0.8,
      sourceSite: 'test',
      summary: 'Uses Supabase for dotctl',
      overview: 'Supabase is the backend choice for dotctl.',
    });
    const otherParentId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'The user prefers Redis for a separate cache experiment.',
      embedding: otherParentEmbedding,
      importance: 0.4,
      sourceSite: 'test',
      summary: 'Redis cache experiment',
    });

    await repo.storeAtomicFacts([
      {
        userId: TEST_USER,
        parentMemoryId: relevantParentId,
        factText: 'As of March 2026, the user is using Supabase for the dotctl backend.',
        embedding: nearbyEmbedding(relevantParentEmbedding, 0.2),
        factType: 'project',
        importance: 0.8,
        sourceSite: 'test',
        keywords: 'Supabase dotctl backend',
      },
      {
        userId: TEST_USER,
        parentMemoryId: otherParentId,
        factText: 'The user uses Redis for a separate cache experiment.',
        embedding: nearbyEmbedding(otherParentEmbedding, 0.2),
        factType: 'project',
        importance: 0.4,
        sourceSite: 'test',
        keywords: 'Redis cache experiment',
      },
    ]);

    const results = await repo.searchAtomicFactsHybrid(
      TEST_USER,
      'What backend does dotctl use?',
      nearbyEmbedding(relevantParentEmbedding, 0.1),
      5,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(relevantParentId);
    expect(results[0].matched_facts?.[0]).toContain('Supabase');
    expect(results[0].retrieval_layer).toBe('atomic_fact');
  });
});
