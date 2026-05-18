/**
 * Integration tests for EntityCardsRepository. Uses the .env.test Postgres
 * instance; assumes the 20260512_entity_cards migration has been applied
 * (via `npm run migrate:test`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { EntityCardsRepository } from '../entity-cards-repository.js';
import { config } from '../../config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = new EntityCardsRepository(pool);

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query("DELETE FROM entity_cards WHERE user_id LIKE 'test-ec-%'");
});

const USER = 'test-ec-1';
const CONV = 'conv-X';

describe('EntityCardsRepository', () => {
  it('inserts a new card via upsert and reads it back', async () => {
    await repo.upsert({
      userId: USER,
      conversationId: CONV,
      entityName: 'user',
      cardText: 'identity: Alice\ncurrent_values: Flask v3.1',
      sourceObservationIds: ['obs-0', 'obs-1', 'obs-2'],
      version: 1,
    });
    const found = await repo.findByConversation(USER, CONV, 10);
    expect(found).toHaveLength(1);
    expect(found[0].entityName).toBe('user');
    expect(found[0].cardText).toContain('Alice');
    expect(found[0].sourceObservationIds).toEqual(['obs-0', 'obs-1', 'obs-2']);
    expect(found[0].version).toBe(1);
  });

  it('upsert on conflict updates card_text and increments version', async () => {
    await repo.upsert({
      userId: USER, conversationId: CONV, entityName: 'user',
      cardText: 'v1', sourceObservationIds: ['o1'], version: 1,
    });
    await repo.upsert({
      userId: USER, conversationId: CONV, entityName: 'user',
      cardText: 'v2', sourceObservationIds: ['o2'], version: 1,
    });
    const found = await repo.findByConversation(USER, CONV, 10);
    expect(found).toHaveLength(1);
    expect(found[0].cardText).toBe('v2');
    expect(found[0].version).toBe(2);
  });

  it('findByConversation returns cards ordered by updated_at DESC, limited', async () => {
    await repo.upsert({
      userId: USER, conversationId: CONV, entityName: 'first',
      cardText: 'a', sourceObservationIds: [], version: 1,
    });
    await repo.upsert({
      userId: USER, conversationId: CONV, entityName: 'second',
      cardText: 'b', sourceObservationIds: [], version: 1,
    });
    const found = await repo.findByConversation(USER, CONV, 1);
    expect(found).toHaveLength(1);
    expect(found[0].entityName).toBe('second');
  });
});
