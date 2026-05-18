/**
 * Integration tests for ReflectionsRepository. Uses the .env.test Postgres
 * instance with the canonical schema applied by the test fixture.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ReflectionsRepository, type NewReflection } from '../reflections-repository.js';
import { config } from '../../config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = new ReflectionsRepository(pool);

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query("DELETE FROM session_reflections WHERE user_id LIKE 'test-refl-%'");
});

const USER = 'test-refl-1';
const CONV = 'conv-A';
const VEC = (n: number): number[] => Array.from({ length: config.embeddingDimensions }, () => n);

describe('ReflectionsRepository', () => {
  it('inserts and reads back reflections by (userId, conversationId)', async () => {
    const rows: NewReflection[] = [
      { userId: USER, conversationId: CONV,
        observation: 'User uses Flask-Login v0.6.2',
        observationType: 'entity_state',
        evidenceMemoryIds: ['m1', 'm2'],
        embedding: VEC(0.1) },
    ];
    await repo.insertMany(rows);
    const found = await repo.findByConversation(USER, CONV);
    expect(found).toHaveLength(1);
    expect(found[0].observation).toBe('User uses Flask-Login v0.6.2');
    expect(found[0].observationType).toBe('entity_state');
    expect(found[0].evidenceMemoryIds).toEqual(['m1', 'm2']);
  });

  it('findSimilar returns the most cosine-similar reflections first', async () => {
    await repo.insertMany([
      { userId: USER, conversationId: CONV,
        observation: 'similar', observationType: 'event_summary',
        evidenceMemoryIds: ['m1'], embedding: VEC(0.1) },
      { userId: USER, conversationId: CONV,
        observation: 'far',     observationType: 'event_summary',
        evidenceMemoryIds: ['m2'], embedding: VEC(-0.9) },
    ]);
    const hits = await repo.findSimilar(USER, VEC(0.1), 2);
    expect(hits[0].observation).toBe('similar');
    expect(hits[1].observation).toBe('far');
  });

  it('returns empty array when no reflections exist', async () => {
    const hits = await repo.findSimilar(USER, VEC(0.5), 5);
    expect(hits).toEqual([]);
  });
});
