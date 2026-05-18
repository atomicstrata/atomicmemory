/**
 * Integration tests for memory_links repository layer.
 * Uses the shared pool module (requires DATABASE_URL).
 *
 * Each test seeds its own memories and links to avoid interference
 * from other test files that may clear global state.
 * Uses a unique user ID to avoid conflicts with parallel tests.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../pool.js';
import { storeMemory, deleteAll } from '../repository-write.js';
import {
  createLinks,
  countLinks,
  findLinkedMemoryIds,
  findLinkCandidates,
  fetchMemoriesByIds,
} from '../repository-links.js';
import { config } from '../../config.js';

const TEST_USER = 'links-test-user-isolated';
const DIM = config.embeddingDimensions;

function makeEmbedding(index: number): number[] {
  const embeddings = [
    Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0)),
    Array.from({ length: DIM }, (_, i) => (i === 0 ? 0.9 : i === 1 ? 0.4 : 0)),
    Array.from({ length: DIM }, (_, i) => (i === 1 ? 1 : 0)),
  ];
  return embeddings[index];
}

async function seedMemories(): Promise<string[]> {
  await deleteAll(pool, TEST_USER);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await storeMemory(pool, {
      userId: TEST_USER,
      content: `test memory ${i}`,
      embedding: makeEmbedding(i),
      importance: 0.5,
      sourceSite: 'test',
    });
    ids.push(id);
  }
  return ids;
}

describe('repository-links', () => {
  afterAll(async () => {
    await deleteAll(pool, TEST_USER);
  });

  it('creates links and counts them', async () => {
    const ids = await seedMemories();
    const created = await createLinks(pool, [
      { sourceId: ids[0], targetId: ids[1], similarity: 0.85 },
      { sourceId: ids[0], targetId: ids[2], similarity: 0.55 },
    ]);
    expect(created).toBe(2);

    const count = await countLinks(pool);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('upserts on conflict', async () => {
    const ids = await seedMemories();
    await createLinks(pool, [
      { sourceId: ids[0], targetId: ids[1], similarity: 0.85 },
    ]);
    const upserted = await createLinks(pool, [
      { sourceId: ids[0], targetId: ids[1], similarity: 0.90 },
    ]);
    expect(upserted).toBe(1);
  });

  it('finds linked memory ids excluding already-selected', async () => {
    const ids = await seedMemories();
    await createLinks(pool, [
      { sourceId: ids[0], targetId: ids[1], similarity: 0.85 },
      { sourceId: ids[0], targetId: ids[2], similarity: 0.55 },
    ]);

    const linked = await findLinkedMemoryIds(
      pool, [ids[0]], new Set([ids[0]]), 10,
    );
    expect(linked).toContain(ids[1]);
    expect(linked).toContain(ids[2]);
    expect(linked).not.toContain(ids[0]);
  });

  it('finds linked ids in both directions', async () => {
    const ids = await seedMemories();
    await createLinks(pool, [
      { sourceId: ids[0], targetId: ids[1], similarity: 0.85 },
    ]);

    const linked = await findLinkedMemoryIds(
      pool, [ids[1]], new Set([ids[1]]), 10,
    );
    expect(linked).toContain(ids[0]);
  });

  it('fetches memories by ids with scores', async () => {
    const ids = await seedMemories();
    const queryEmbedding = makeEmbedding(0);
    const results = await fetchMemoriesByIds(pool, TEST_USER, [ids[1]], queryEmbedding);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(ids[1]);
    expect(results[0].similarity).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('finds link candidates above threshold', async () => {
    const ids = await seedMemories();
    const queryEmbedding = makeEmbedding(0);
    const candidates = await findLinkCandidates(
      pool, TEST_USER, queryEmbedding, 0.3, ids[0], 10,
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.id !== ids[0])).toBe(true);
  });
});
