/**
 * Integration tests for the BEAM v38 supersede UPDATE.
 * Uses the .env.test Postgres; assumes the 20260512_temporal_state
 * migration has been applied (via `npm run migrate:test`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { storeMemory, deleteAll } from '../repository-write.js';
import {
  findActiveStateMemoryIds,
  supersedePriorStateMemories,
} from '../repository-temporal-state.js';
import { config } from '../../config.js';
import { basisVector } from './test-fixtures.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const USER = 'test-temporal-1';
const STATE_KEY = 'user:test-temporal-1:location';

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await deleteAll(pool, USER);
});

const makeEmbedding = basisVector;

async function storeStateful(content: string, eventStart: Date, seed: number): Promise<string> {
  return storeMemory(pool, {
    userId: USER, content,
    embedding: makeEmbedding(seed),
    importance: 0.5, sourceSite: 'test',
    stateKey: STATE_KEY,
    eventStart,
    eventEnd: null,
  });
}

describe('supersedePriorStateMemories', () => {
  it('closes event_end on a single prior memory when a new one arrives', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-03-01T00:00:00Z');
    const oldId = await storeStateful('User lives in Austin', t0, 0);
    const newId = await storeStateful('User lives in Tokyo', t1, 1);

    const activeBefore = await findActiveStateMemoryIds(pool, USER, STATE_KEY);
    expect(activeBefore.sort()).toEqual([oldId, newId].sort());

    const rowCount = await supersedePriorStateMemories(pool, {
      userId: USER, stateKey: STATE_KEY, newMemoryId: newId, eventEnd: t1,
    });
    expect(rowCount).toBe(1);

    const activeAfter = await findActiveStateMemoryIds(pool, USER, STATE_KEY);
    expect(activeAfter).toEqual([newId]);
  });

  it('does not close event_end on the new memory itself', async () => {
    const t1 = new Date('2026-03-01T00:00:00Z');
    const newId = await storeStateful('User lives in Tokyo', t1, 1);
    const rowCount = await supersedePriorStateMemories(pool, {
      userId: USER, stateKey: STATE_KEY, newMemoryId: newId, eventEnd: t1,
    });
    expect(rowCount).toBe(0);
    const active = await findActiveStateMemoryIds(pool, USER, STATE_KEY);
    expect(active).toEqual([newId]);
  });

  it('only closes rows under the matching state_key', async () => {
    const otherKey = 'user:test-temporal-1:job';
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-03-01T00:00:00Z');
    const locationId = await storeStateful('User lives in Austin', t0, 0);
    const jobId = await storeMemory(pool, {
      userId: USER, content: 'User works at Acme',
      embedding: makeEmbedding(2),
      importance: 0.5, sourceSite: 'test',
      stateKey: otherKey, eventStart: t0, eventEnd: null,
    });
    const newLocation = await storeStateful('User lives in Tokyo', t1, 1);

    const rowCount = await supersedePriorStateMemories(pool, {
      userId: USER, stateKey: STATE_KEY, newMemoryId: newLocation, eventEnd: t1,
    });
    expect(rowCount).toBe(1);

    const jobActive = await findActiveStateMemoryIds(pool, USER, otherKey);
    expect(jobActive).toEqual([jobId]);
    const locActive = await findActiveStateMemoryIds(pool, USER, STATE_KEY);
    expect(locActive).toEqual([newLocation]);
    void locationId;
  });
});
