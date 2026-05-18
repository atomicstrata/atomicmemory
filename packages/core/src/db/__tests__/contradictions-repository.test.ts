/**
 * Integration tests for ContradictionsRepository. Uses the .env.test Postgres
 * instance; assumes the 20260512_audn_bilateral migration has been applied
 * (via `npm run migrate:test`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ContradictionsRepository } from '../contradictions-repository.js';
import { storeMemory, deleteAll } from '../repository-write.js';
import { config } from '../../config.js';
import { basisVector } from './test-fixtures.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = new ContradictionsRepository(pool);
const USER = 'test-contradictions-1';

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`DELETE FROM memory_contradictions WHERE user_id = $1`, [USER]);
  await deleteAll(pool, USER);
});

const makeEmbedding = basisVector;

async function seedTwoMemories(): Promise<{ leftId: string; rightId: string }> {
  const leftId = await storeMemory(pool, {
    userId: USER, content: 'User prefers TypeScript.',
    embedding: makeEmbedding(0), importance: 0.5, sourceSite: 'test',
  });
  const rightId = await storeMemory(pool, {
    userId: USER, content: 'User prefers Python.',
    embedding: makeEmbedding(1), importance: 0.5, sourceSite: 'test',
  });
  return { leftId, rightId };
}

describe('ContradictionsRepository', () => {
  it('records a contradiction and returns the id', async () => {
    const { leftId, rightId } = await seedTwoMemories();
    const id = await repo.record({
      userId: USER, conversationId: 'conv-1',
      leftMemoryId: leftId, rightMemoryId: rightId,
      leftSummary: 'User prefers TypeScript.',
      rightSummary: 'User prefers Python.',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('findActiveByUserAndMemoryIds returns rows matching either side', async () => {
    const { leftId, rightId } = await seedTwoMemories();
    const contradictionId = await repo.record({
      userId: USER, conversationId: 'conv-1',
      leftMemoryId: leftId, rightMemoryId: rightId,
      leftSummary: 'User prefers TypeScript.',
      rightSummary: 'User prefers Python.',
    });
    const byLeft = await repo.findActiveByUserAndMemoryIds(USER, [leftId]);
    expect(byLeft).toHaveLength(1);
    expect(byLeft[0].id).toBe(contradictionId);
    expect(byLeft[0].leftSummary).toBe('User prefers TypeScript.');
    expect(byLeft[0].rightSummary).toBe('User prefers Python.');
    const byRight = await repo.findActiveByUserAndMemoryIds(USER, [rightId]);
    expect(byRight).toHaveLength(1);
    expect(byRight[0].id).toBe(contradictionId);
  });

  it('findActiveByUserAndMemoryIds returns empty for unknown ids', async () => {
    const found = await repo.findActiveByUserAndMemoryIds(USER, [
      '00000000-0000-0000-0000-000000000000',
    ]);
    expect(found).toEqual([]);
  });

  it('findActiveByUserAndMemoryIds returns empty for empty input', async () => {
    const found = await repo.findActiveByUserAndMemoryIds(USER, []);
    expect(found).toEqual([]);
  });

  it('markContradictionFlagsBilateral sets both memories flags and counterparts', async () => {
    const { leftId, rightId } = await seedTwoMemories();
    await repo.markContradictionFlagsBilateral(USER, leftId, rightId);
    const { rows } = await pool.query(
      `SELECT id, contradicts_memory_id, contradiction_active
       FROM memories WHERE user_id = $1 ORDER BY content`,
      [USER],
    );
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(leftId).contradiction_active).toBe(true);
    expect(byId.get(leftId).contradicts_memory_id).toBe(rightId);
    expect(byId.get(rightId).contradiction_active).toBe(true);
    expect(byId.get(rightId).contradicts_memory_id).toBe(leftId);
  });

  it('markContradictionFlagsBilateral fails closed when a memory is missing', async () => {
    const { leftId } = await seedTwoMemories();
    await expect(
      repo.markContradictionFlagsBilateral(
        USER, leftId, '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toThrow(/expected to update 2 rows/);
  });
});
