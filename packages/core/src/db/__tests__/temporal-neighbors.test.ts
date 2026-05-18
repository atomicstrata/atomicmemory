/**
 * Integration tests for temporal-neighbor expansion query.
 * Verifies that findTemporalNeighbors surfaces memories created
 * within a time window of anchor timestamps.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../pool.js';
import { storeMemory, deleteAll } from '../repository-write.js';
import { findTemporalNeighbors } from '../repository-read.js';
import { config } from '../../config.js';

const TEST_USER = 'temporal-test-user';

function makeEmbedding(index: number): number[] {
  return Array.from({ length: config.embeddingDimensions }, (_, i) => (i === index ? 1 : 0));
}

async function seedWithTimestamps(): Promise<{ ids: string[]; timestamps: Date[] }> {
  await deleteAll(pool, TEST_USER);
  const ids: string[] = [];
  const timestamps: Date[] = [];

  const baseTime = new Date('2026-01-15T10:00:00Z');
  const offsets = [0, 5, 10, 60, 120];

  for (let i = 0; i < offsets.length; i++) {
    const id = await storeMemory(pool, {
      userId: TEST_USER,
      content: `temporal memory ${i} offset=${offsets[i]}min`,
      embedding: makeEmbedding(i),
      importance: 0.5,
      sourceSite: 'test',
    });
    ids.push(id);

    const ts = new Date(baseTime.getTime() + offsets[i] * 60_000);
    await pool.query(
      'UPDATE memories SET created_at = $1 WHERE id = $2',
      [ts, id],
    );
    timestamps.push(ts);
  }
  return { ids, timestamps };
}

describe('findTemporalNeighbors', () => {
  afterAll(async () => {
    await deleteAll(pool, TEST_USER);
  });

  it('finds neighbors within the time window', async () => {
    const { ids, timestamps } = await seedWithTimestamps();
    const neighborIds = await queryNeighborIds(ids, timestamps, [ids[0]]);
    expect(neighborIds).toContain(ids[1]);
    expect(neighborIds).toContain(ids[2]);
    expect(neighborIds).not.toContain(ids[3]);
    expect(neighborIds).not.toContain(ids[4]);
  });

  it('excludes specified ids', async () => {
    const { ids, timestamps } = await seedWithTimestamps();
    const neighborIds = await queryNeighborIds(ids, timestamps, [ids[0], ids[1]]);
    expect(neighborIds).not.toContain(ids[0]);
    expect(neighborIds).not.toContain(ids[1]);
    expect(neighborIds).toContain(ids[2]);
  });

  it('returns scored results sorted by score descending', async () => {
    const { ids, timestamps } = await seedWithTimestamps();
    const queryEmbedding = makeEmbedding(0);

    const neighbors = await findTemporalNeighbors(
      pool, TEST_USER, [timestamps[0]], queryEmbedding, 15, new Set(), 10,
    );

    expect(neighbors.length).toBeGreaterThan(0);
    for (const n of neighbors) {
      expect(n.score).toBeGreaterThan(0);
      expect(n.similarity).toBeDefined();
    }
    for (let i = 1; i < neighbors.length; i++) {
      expect(neighbors[i - 1].score).toBeGreaterThanOrEqual(neighbors[i].score);
    }
  });

  it('returns empty for no anchors', async () => {
    const queryEmbedding = makeEmbedding(0);
    const neighbors = await findTemporalNeighbors(
      pool, TEST_USER, [], queryEmbedding, 15, new Set(), 10,
    );
    expect(neighbors).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    const { timestamps } = await seedWithTimestamps();
    const queryEmbedding = makeEmbedding(0);

    const neighbors = await findTemporalNeighbors(
      pool, TEST_USER, [timestamps[0]], queryEmbedding, 15, new Set(), 1,
    );
    expect(neighbors.length).toBeLessThanOrEqual(1);
  });
});

/** Run a temporal neighbor query and return just the result IDs. */
async function queryNeighborIds(ids: string[], timestamps: Date[], excludeIdList: string[]) {
  const neighbors = await findTemporalNeighbors(
    pool, TEST_USER, [timestamps[0]], makeEmbedding(0), 15, new Set(excludeIdList), 10,
  );
  return neighbors.map((n) => n.id);
}
