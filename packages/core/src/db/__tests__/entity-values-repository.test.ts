/**
 * Integration tests for EntityValuesRepository against the canonical
 * test schema. This guards the schema.sql mirror for the v66
 * entity_values migration.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { config } from '../../config.js';
import { EntityValuesRepository, type NewEntityValue } from '../entity-values-repository.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = new EntityValuesRepository(pool);
const USER = 'test-entity-values-1';

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query("DELETE FROM entity_values WHERE user_id LIKE 'test-entity-values-%'");
});

describe('EntityValuesRepository', () => {
  it('inserts literal values and returns the latest matching entity attribute', async () => {
    const older = buildValue('March 12', new Date('2026-03-12T12:00:00Z'));
    const newer = buildValue('March 29', new Date('2026-03-29T12:00:00Z'));

    await repo.insertMany([older, newer]);

    const found = await repo.findLatest(USER, 'first sprint', 'end date');
    expect(found?.value).toBe('March 29');
    expect(found?.valueType).toBe('date');
    expect(found?.factId).toBe(newer.factId);
  });

  it('returns null when no entity attribute matches', async () => {
    await repo.insertMany([
      buildValue('March 29', new Date('2026-03-29T12:00:00Z')),
    ]);

    await expect(repo.findLatest(USER, 'second sprint', 'end date')).resolves.toBeNull();
  });
});

function buildValue(value: string, observedAt: Date): NewEntityValue {
  return {
    userId: USER,
    entity: 'first sprint',
    attribute: 'end date',
    value,
    valueType: 'date',
    observedAt,
    factId: crypto.randomUUID(),
  };
}
