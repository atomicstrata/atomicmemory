/**
 * Integration tests for TllRepository — the per-entity Temporal Linkage List.
 *
 * Validates:
 *   - append() idempotency on (user_id, entity_id, memory_id)
 *   - append() predecessor wiring + position_in_chain bookkeeping
 *   - chain() ordering by position_in_chain ASC
 *   - chainsFor() dedup + observation_date ordering, empty-input shortcut
 *   - chainEventsForEntities() enriched join, drops empty entities,
 *     preserves position order, empty-input shortcut
 *
 * Requires DATABASE_URL in .env.test. Runs against the live test schema.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../pool.js';
import { TllRepository } from '../repository-tll.js';
import { EntityRepository } from '../repository-entities.js';
import { MemoryRepository } from '../memory-repository.js';
import { setupTestSchema, unitVector } from './test-fixtures.js';

const TEST_USER = 'tll-repo-test-user';

interface SeededEntity { id: string; }
interface SeededMemory { id: string; date: Date; }

describe('TllRepository', () => {
  const tllRepo = new TllRepository(pool);
  const entityRepo = new EntityRepository(pool);
  const memoryRepo = new MemoryRepository(pool);

  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM temporal_linkage_list WHERE user_id = $1', [TEST_USER]);
    await entityRepo.deleteAll();
    await memoryRepo.deleteAll();
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Resolve a fresh entity for the test user with a deterministic seed. */
  async function makeEntity(name: string, seed: number): Promise<SeededEntity> {
    const id = await entityRepo.resolveEntity({
      userId: TEST_USER,
      name,
      entityType: 'tool',
      embedding: unitVector(seed),
    });
    return { id };
  }

  /** Store a memory and return its id along with its observation_date. */
  async function makeMemory(content: string, seed: number, date: Date): Promise<SeededMemory> {
    const id = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content,
      embedding: unitVector(seed),
      importance: 0.6,
      sourceSite: 'test',
    });
    return { id, date };
  }

  /**
   * Store a workspace-scoped memory. Used to verify that the global
   * `chainEventsForEntities` endpoint never surfaces workspace memories.
   * Any non-null UUID for `workspaceId` is sufficient for the
   * `workspace_id IS NULL` filter to drop the row.
   */
  async function makeWorkspaceMemory(content: string, seed: number, date: Date): Promise<SeededMemory> {
    const id = await memoryRepo.storeMemory({
      userId: TEST_USER,
      content,
      embedding: unitVector(seed),
      importance: 0.6,
      sourceSite: 'test',
      workspaceId: '00000000-0000-0000-0000-00000000ffff',
      agentId: '00000000-0000-0000-0000-0000000000aa',
    });
    return { id, date };
  }

  /**
   * Seed three memories whose insertion order (middle, latest, earliest)
   * is deliberately out-of-order vs their observation dates (Feb, Mar,
   * Jan) and append them to the TLL for `entityId`. Returns the three
   * stored memories so the caller can assert chronological ordering of
   * the resulting chain.
   */
  async function seedOutOfOrderBackfillChain(
    entityId: string,
    seedBase: number,
  ): Promise<{ middle: SeededMemory; latest: SeededMemory; earliest: SeededMemory }> {
    const middle = await makeMemory('middle', seedBase, new Date('2026-02-01'));
    const latest = await makeMemory('latest', seedBase + 1, new Date('2026-03-01'));
    const earliest = await makeMemory('earliest', seedBase + 2, new Date('2026-01-01'));
    await tllRepo.append(TEST_USER, middle.id, [entityId], middle.date);
    await tllRepo.append(TEST_USER, latest.id, [entityId], latest.date);
    await tllRepo.append(TEST_USER, earliest.id, [entityId], earliest.date);
    return { middle, latest, earliest };
  }

  /** Count rows in TLL for a (user, entity, memory) triple. */
  async function countRows(entityId: string, memoryId: string): Promise<number> {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM temporal_linkage_list
       WHERE user_id = $1 AND entity_id = $2 AND memory_id = $3`,
      [TEST_USER, entityId, memoryId],
    );
    return Number.parseInt(r.rows[0].c, 10);
  }

  describe('append()', () => {
    it('is idempotent on (user_id, entity_id, memory_id)', async () => {
      const ent = await makeEntity('Postgres', 11);
      const mem = await makeMemory('User uses Postgres', 12, new Date('2026-01-10'));

      await tllRepo.append(TEST_USER, mem.id, [ent.id], mem.date);
      await tllRepo.append(TEST_USER, mem.id, [ent.id], mem.date);

      expect(await countRows(ent.id, mem.id)).toBe(1);
    });

    it('returns early without writing when entityIds is empty', async () => {
      const mem = await makeMemory('No-entity memory', 14, new Date('2026-01-10'));
      await tllRepo.append(TEST_USER, mem.id, [], mem.date);

      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM temporal_linkage_list WHERE user_id = $1`,
        [TEST_USER],
      );
      expect(Number.parseInt(r.rows[0].c, 10)).toBe(0);
    });

    it('wires predecessor + position_in_chain across two appends', async () => {
      const ent = await makeEntity('React', 21);
      const memA = await makeMemory('first', 22, new Date('2026-01-01'));
      const memB = await makeMemory('second', 23, new Date('2026-02-01'));

      await tllRepo.append(TEST_USER, memA.id, [ent.id], memA.date);
      await tllRepo.append(TEST_USER, memB.id, [ent.id], memB.date);

      const events = await tllRepo.chain(TEST_USER, ent.id);
      expect(events).toHaveLength(2);
      expect(events[0].memoryId).toBe(memA.id);
      expect(events[0].positionInChain).toBe(0);
      expect(events[0].predecessorMemoryId).toBeNull();
      expect(events[1].memoryId).toBe(memB.id);
      expect(events[1].positionInChain).toBe(1);
      expect(events[1].predecessorMemoryId).toBe(memA.id);
    });

    it('deduplicates duplicate entityIds within a single call', async () => {
      const ent = await makeEntity('Vue', 31);
      const mem = await makeMemory('dup', 32, new Date('2026-01-15'));

      await tllRepo.append(TEST_USER, mem.id, [ent.id, ent.id, ent.id], mem.date);

      expect(await countRows(ent.id, mem.id)).toBe(1);
    });

    it('serializes concurrent appends to the same chain without duplicate positions', async () => {
      const ent = await makeEntity('Concurrent', 121);
      const mA = await makeMemory('concA', 122, new Date('2026-05-01'));
      const mB = await makeMemory('concB', 123, new Date('2026-05-02'));
      const mC = await makeMemory('concC', 124, new Date('2026-05-03'));

      await Promise.all([
        tllRepo.append(TEST_USER, mA.id, [ent.id], mA.date),
        tllRepo.append(TEST_USER, mB.id, [ent.id], mB.date),
        tllRepo.append(TEST_USER, mC.id, [ent.id], mC.date),
      ]);

      const events = await tllRepo.chain(TEST_USER, ent.id);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.positionInChain)).toEqual([0, 1, 2]);
      expect(new Set(events.map((e) => e.memoryId)).size).toBe(3);
      expect(events[0].predecessorMemoryId).toBeNull();
      expect(events[1].predecessorMemoryId).toBe(events[0].memoryId);
      expect(events[2].predecessorMemoryId).toBe(events[1].memoryId);
    });
  });

  describe('chain()', () => {
    it('returns events ordered by position_in_chain ASC', async () => {
      const ent = await makeEntity('Docker', 41);
      const m1 = await makeMemory('one', 42, new Date('2026-03-01'));
      const m2 = await makeMemory('two', 43, new Date('2026-03-15'));
      const m3 = await makeMemory('three', 44, new Date('2026-04-01'));

      await tllRepo.append(TEST_USER, m1.id, [ent.id], m1.date);
      await tllRepo.append(TEST_USER, m2.id, [ent.id], m2.date);
      await tllRepo.append(TEST_USER, m3.id, [ent.id], m3.date);

      const events = await tllRepo.chain(TEST_USER, ent.id);
      const positions = events.map((e) => e.positionInChain);
      expect(positions).toEqual([0, 1, 2]);
      expect(events.map((e) => e.memoryId)).toEqual([m1.id, m2.id, m3.id]);
    });

    it('returns [] for an entity with no events', async () => {
      const ent = await makeEntity('Lonely', 51);
      const events = await tllRepo.chain(TEST_USER, ent.id);
      expect(events).toEqual([]);
    });

    it('orders by observation_date — backfilled out-of-order events get chronological positions and predecessors', async () => {
      const ent = await makeEntity('BackfillChain', 56);
      const seeded = await seedOutOfOrderBackfillChain(ent.id, 57);

      const events = await tllRepo.chain(TEST_USER, ent.id);
      expect(events.map((e) => e.memoryId)).toEqual([seeded.earliest.id, seeded.middle.id, seeded.latest.id]);
      expect(events.map((e) => e.positionInChain)).toEqual([0, 1, 2]);
      expect(events.map((e) => e.predecessorMemoryId)).toEqual([null, seeded.earliest.id, seeded.middle.id]);
    });
  });

  describe('chainsFor()', () => {
    it('returns [] without querying when entityIds is empty', async () => {
      const ids = await tllRepo.chainsFor(TEST_USER, []);
      expect(ids).toEqual([]);
    });

    it('returns deduped memory_ids ordered by observation_date ASC', async () => {
      const e1 = await makeEntity('TypeScript', 61);
      const e2 = await makeEntity('Node.js', 62);
      const earliest = await makeMemory('earliest', 63, new Date('2026-01-01'));
      const middle = await makeMemory('middle', 64, new Date('2026-02-01'));
      const latest = await makeMemory('latest', 65, new Date('2026-03-01'));

      await tllRepo.append(TEST_USER, latest.id, [e1.id, e2.id], latest.date);
      await tllRepo.append(TEST_USER, earliest.id, [e1.id], earliest.date);
      await tllRepo.append(TEST_USER, middle.id, [e2.id], middle.date);

      const ids = await tllRepo.chainsFor(TEST_USER, [e1.id, e2.id]);

      expect(ids).toEqual([earliest.id, middle.id, latest.id]);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('isolates results by user', async () => {
      const e1 = await makeEntity('Rust', 71);
      const m1 = await makeMemory('mine', 72, new Date('2026-01-10'));
      await tllRepo.append(TEST_USER, m1.id, [e1.id], m1.date);

      const ids = await tllRepo.chainsFor('different-user', [e1.id]);
      expect(ids).toEqual([]);
    });
  });

  describe('chainEventsForEntities()', () => {
    it('returns [] without querying when entityIds is empty', async () => {
      const result = await tllRepo.chainEventsForEntities(TEST_USER, []);
      expect(result).toEqual([]);
    });

    it('returns enriched events grouped by entity, position-ordered', async () => {
      const ent = await makeEntity('Kafka', 81);
      const m1 = await makeMemory('first event', 82, new Date('2026-01-01'));
      const m2 = await makeMemory('second event', 83, new Date('2026-02-01'));

      await tllRepo.append(TEST_USER, m1.id, [ent.id], m1.date);
      await tllRepo.append(TEST_USER, m2.id, [ent.id], m2.date);

      const result = await tllRepo.chainEventsForEntities(TEST_USER, [ent.id]);

      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe(ent.id);
      expect(result[0].events).toHaveLength(2);
      expect(result[0].events[0].positionInChain).toBe(0);
      expect(result[0].events[0].memoryId).toBe(m1.id);
      expect(result[0].events[0].content).toBe('first event');
      expect(result[0].events[0].predecessorMemoryId).toBeNull();
      expect(result[0].events[1].positionInChain).toBe(1);
      expect(result[0].events[1].memoryId).toBe(m2.id);
      expect(result[0].events[1].content).toBe('second event');
      expect(result[0].events[1].predecessorMemoryId).toBe(m1.id);
    });

    it('drops entities that have no events', async () => {
      const populated = await makeEntity('Populated', 91);
      const empty = await makeEntity('Empty', 92);
      const mem = await makeMemory('only one', 93, new Date('2026-01-05'));

      await tllRepo.append(TEST_USER, mem.id, [populated.id], mem.date);

      const result = await tllRepo.chainEventsForEntities(
        TEST_USER, [populated.id, empty.id],
      );
      expect(result).toHaveLength(1);
      expect(result[0].entityId).toBe(populated.id);
    });

    it('excludes events whose memory is soft-deleted', async () => {
      const ent = await makeEntity('Soft Delete', 101);
      const live = await makeMemory('live', 102, new Date('2026-01-01'));
      const dead = await makeMemory('dead', 103, new Date('2026-02-01'));

      await tllRepo.append(TEST_USER, live.id, [ent.id], live.date);
      await tllRepo.append(TEST_USER, dead.id, [ent.id], dead.date);
      await memoryRepo.softDeleteMemory(TEST_USER, dead.id);

      const result = await tllRepo.chainEventsForEntities(TEST_USER, [ent.id]);

      expect(result).toHaveLength(1);
      expect(result[0].events.map((e) => e.memoryId)).toEqual([live.id]);
    });

    it('orders backfilled events by observation_date with chronological predecessors', async () => {
      const ent = await makeEntity('Backfill', 111);
      // Insertion order: middle, latest, earliest. Observation order: jan, feb, mar.
      const seeded = await seedOutOfOrderBackfillChain(ent.id, 112);

      const result = await tllRepo.chainEventsForEntities(TEST_USER, [ent.id]);
      expect(result).toHaveLength(1);
      const events = result[0].events;
      expect(events.map((e) => e.memoryId)).toEqual([seeded.earliest.id, seeded.middle.id, seeded.latest.id]);
      expect(events.map((e) => e.positionInChain)).toEqual([0, 1, 2]);
      expect(events[0].predecessorMemoryId).toBeNull();
      expect(events[1].predecessorMemoryId).toBe(seeded.earliest.id);
      expect(events[2].predecessorMemoryId).toBe(seeded.middle.id);
    });

    it('omits events whose memory has a non-null workspace_id (global endpoint isolation)', async () => {
      const ent = await makeEntity('GlobalEntity', 121);
      const global = await makeMemory('global memory', 122, new Date('2026-01-01'));
      const workspaceMem = await makeWorkspaceMemory('workspace memory', 123, new Date('2026-02-01'));

      await tllRepo.append(TEST_USER, global.id, [ent.id], global.date);
      await tllRepo.append(TEST_USER, workspaceMem.id, [ent.id], workspaceMem.date);

      const result = await tllRepo.chainEventsForEntities(TEST_USER, [ent.id]);
      expect(result).toHaveLength(1);
      expect(result[0].events.map((e) => e.memoryId)).toEqual([global.id]);
    });
  });
});
