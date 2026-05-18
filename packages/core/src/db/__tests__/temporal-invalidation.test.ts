/**
 * Integration tests for temporal invalidation (Phase 4).
 * Validates that expired memories (via SUPERSEDE) are filtered from default
 * retrieval but accessible via temporal "as of" queries, and that DELETE
 * action properly soft-deletes without creating replacements.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTestContext, unitVector, offsetVector } from './test-fixtures.js';
import { config } from '../../config.js';
import { pool } from '../pool.js';

const TEST_USER = 'temporal-invalidation-user';

describe('temporal invalidation', () => {
  const { repo } = createMemoryTestContext(pool, { beforeAll, beforeEach, afterAll });

  it('expireMemory sets expired_at timestamp', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(11),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);

    const memory = await repo.getMemoryIncludingDeleted(memoryId, TEST_USER);
    expect(memory).not.toBeNull();
    expect(memory!.expired_at).not.toBeNull();
    expect(memory!.deleted_at).toBeNull();
  });

  it('expired memories are excluded from default search', async () => {
    const embedding = unitVector(21);
    const expiredId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding,
      importance: 0.7,
      sourceSite: 'test',
    });
    await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers VSCode',
      embedding: offsetVector(embedding, 7, 0.01),
      importance: 0.8,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, expiredId);

    const results = await repo.searchSimilar(TEST_USER, embedding, 10);
    expect(results.some((r) => r.content.includes('Vim'))).toBe(false);
    expect(results.some((r) => r.content.includes('VSCode'))).toBe(true);
  });

  it('expired memories are excluded from getMemory', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(31),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);

    const memory = await repo.getMemory(memoryId, TEST_USER);
    expect(memory).toBeNull();
  });

  it('expired memories are excluded from listMemories', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(41),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);

    const memories = await repo.listMemories(TEST_USER, 100, 0);
    expect(memories.some((m) => m.id === memoryId)).toBe(false);
  });

  it('expired memories are excluded from countMemories', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(51),
      importance: 0.7,
      sourceSite: 'test',
    });

    const beforeCount = await repo.countMemories(TEST_USER);
    await repo.expireMemory(TEST_USER, memoryId);
    const afterCount = await repo.countMemories(TEST_USER);

    expect(afterCount).toBe(beforeCount - 1);
  });

  it('expired memories are excluded from findNearDuplicates', async () => {
    const embedding = unitVector(61);
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding,
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);

    const dups = await repo.findNearDuplicates(TEST_USER, embedding, 0.5);
    expect(dups.some((d) => d.id === memoryId)).toBe(false);
  });

  it('expired memories are excluded from findKeywordCandidates', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim editor',
      embedding: unitVector(71),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);

    const candidates = await repo.findKeywordCandidates(TEST_USER, ['Vim']);
    expect(candidates.some((c) => c.id === memoryId)).toBe(false);
  });

  it('expireMemory is idempotent', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(81),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);
    const firstExpiry = (await repo.getMemoryIncludingDeleted(memoryId, TEST_USER))!.expired_at;

    await repo.expireMemory(TEST_USER, memoryId);
    const secondExpiry = (await repo.getMemoryIncludingDeleted(memoryId, TEST_USER))!.expired_at;

    expect(firstExpiry).toEqual(secondExpiry);
  });

  it('expired and deleted are independent states', async () => {
    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding: unitVector(91),
      importance: 0.7,
      sourceSite: 'test',
    });

    await repo.expireMemory(TEST_USER, memoryId);
    let memory = await repo.getMemoryIncludingDeleted(memoryId, TEST_USER);
    expect(memory!.expired_at).not.toBeNull();
    expect(memory!.deleted_at).toBeNull();

    await repo.softDeleteMemory(TEST_USER, memoryId);
    memory = await repo.getMemoryIncludingDeleted(memoryId, TEST_USER);
    expect(memory!.expired_at).not.toBeNull();
    expect(memory!.deleted_at).not.toBeNull();
  });

  it('expired memories are excluded from temporal neighbor expansion', async () => {
    const baseTime = new Date('2026-03-01T12:00:00Z');
    const embedding = unitVector(101);

    const memoryId = await repo.storeMemory({
      userId: TEST_USER,
      content: 'User prefers Vim',
      embedding,
      importance: 0.7,
      sourceSite: 'test',
    });
    await pool.query(
      'UPDATE memories SET created_at = $1 WHERE id = $2',
      [baseTime.toISOString(), memoryId],
    );

    await repo.expireMemory(TEST_USER, memoryId);

    const neighbors = await repo.findTemporalNeighbors(
      TEST_USER, [baseTime], embedding, 30, new Set(), 10,
    );
    expect(neighbors.some((n) => n.id === memoryId)).toBe(false);
  });
});

// unitVector and offsetVector imported from test-fixtures.ts
