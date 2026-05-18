/**
 * Integration tests for FirstMentionRepository.
 *
 * Validates the storage idempotency contract that pairs with review #7:
 * the `(user_id, memory_id)` UNIQUE constraint silently drops duplicate
 * inserts, so a re-run of `extractAndStore` for the same conversation
 * never produces extra rows. The service layer's post-sorted index
 * `positionInConversation` makes the read-back deterministic across
 * re-runs even when the LLM's turn_id assignment drifts; this test
 * exercises the DB half of that guarantee.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import { FirstMentionRepository, type FirstMentionEvent } from '../repository-first-mentions.js';
import { MemoryRepository } from '../memory-repository.js';
import { setupTestSchema, unitVector } from './test-fixtures.js';

const TEST_USER = 'first-mentions-repo-test-user';

describe('FirstMentionRepository', () => {
  const fmRepo = new FirstMentionRepository(pool);
  const memoryRepo = new MemoryRepository(pool);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM first_mention_events WHERE user_id = $1',
      [TEST_USER],
    );
    await memoryRepo.deleteAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeMemory(content: string, seed: number): Promise<string> {
    return memoryRepo.storeMemory({
      userId: TEST_USER,
      content,
      embedding: unitVector(seed),
      importance: 0.5,
      sourceSite: 'first-mention-test',
    });
  }

  async function countRows(): Promise<number> {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM first_mention_events WHERE user_id = $1`,
      [TEST_USER],
    );
    return Number.parseInt(r.rows[0].c, 10);
  }

  it('store() is idempotent on (user_id, memory_id) across re-runs (review #7)', async () => {
    const memA = await makeMemory('A topic memory', 1);
    const memB = await makeMemory('B topic memory', 2);

    // Run 1: turn_ids 5/12, position 0/1.
    const run1: FirstMentionEvent[] = [
      { topic: 'A', turnId: 5, memoryId: memA, anchorDate: null, positionInConversation: 0 },
      { topic: 'B', turnId: 12, memoryId: memB, anchorDate: null, positionInConversation: 1 },
    ];
    await fmRepo.store(TEST_USER, 'beam', run1);

    // Run 2: same logical topics but the LLM drifted A's turn_id 5 -> 6.
    // The post-sorted index keeps positionInConversation = 0/1 so the
    // INSERT shape is identical to the row already on disk; ON CONFLICT
    // (user_id, memory_id) DO NOTHING drops the duplicate cleanly.
    const run2: FirstMentionEvent[] = [
      { topic: 'A', turnId: 6, memoryId: memA, anchorDate: null, positionInConversation: 0 },
      { topic: 'B', turnId: 12, memoryId: memB, anchorDate: null, positionInConversation: 1 },
    ];
    await fmRepo.store(TEST_USER, 'beam', run2);

    expect(await countRows()).toBe(2);
    const list = await fmRepo.list(TEST_USER);
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.topic)).toEqual(['A', 'B']);
    expect(list.map((e) => e.positionInConversation)).toEqual([0, 1]);
    // The first-write wins per ON CONFLICT DO NOTHING — original turn_id
    // for A (5) is what survives, not the drifted 6.
    const a = list.find((e) => e.topic === 'A');
    expect(a?.turnId).toBe(5);
  });

  it('store() does no work when the events array is empty', async () => {
    await fmRepo.store(TEST_USER, 'beam', []);
    expect(await countRows()).toBe(0);
  });

  it('list() returns events ordered by position_in_conversation ASC', async () => {
    const m1 = await makeMemory('m1', 11);
    const m2 = await makeMemory('m2', 12);
    const m3 = await makeMemory('m3', 13);

    // Insert deliberately out of position order.
    await fmRepo.store(TEST_USER, 'beam', [
      { topic: 'middle', turnId: 5, memoryId: m2, anchorDate: null, positionInConversation: 1 },
      { topic: 'late', turnId: 9, memoryId: m3, anchorDate: null, positionInConversation: 2 },
      { topic: 'early', turnId: 2, memoryId: m1, anchorDate: null, positionInConversation: 0 },
    ]);

    const list = await fmRepo.list(TEST_USER);
    expect(list.map((e) => e.topic)).toEqual(['early', 'middle', 'late']);
    expect(list.map((e) => e.positionInConversation)).toEqual([0, 1, 2]);
  });

  it('getByMemoryId() returns null when no event exists for the memory', async () => {
    const memA = await makeMemory('A', 21);
    const result = await fmRepo.getByMemoryId(TEST_USER, memA);
    expect(result).toBeNull();
  });
});
