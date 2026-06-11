/**
 * DB-backed integration test for the external_id idempotency invariant (PR #18).
 *
 * Runs the real migration runner against a real Postgres and exercises the real
 * write (`storeMemory`) and read (`findMemoryByExternalId`) paths to prove:
 *
 *   1. migration 0003's partial UNIQUE index rejects a second LIVE row sharing
 *      `(user_id, metadata.externalId)` with SQLSTATE 23505 — the hard
 *      constraint `performStoreVerbatim`'s check-then-update relies on. The unit
 *      test (`services/__tests__/verbatim-dedup.test.ts`) mocks the store and
 *      proves "on 23505 we re-read + update"; this proves real Postgres actually
 *      raises 23505 on the duplicate, so the two together cover the fix.
 *   2. rows WITHOUT an externalId (NULL) are NOT constrained (partial predicate).
 *   3. a stored memory resolves by its external id through the real read path
 *      (`GET /v1/memories/by-external-id` is backed by `findMemoryByExternalId`).
 *
 * Requires a disposable Postgres (the shared migration-test harness drops and
 * recreates the `public` schema per test). Run via the package test suite with
 * `DATABASE_URL` pointing at a throwaway database.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { findMemoryByExternalId } from '../repository-read.js';
import { storeMemory } from '../repository-write.js';
import type { StoreMemoryInput } from '../repository-types.js';
import { migrate } from '../migration-api.js';
import { applyLegacySchema, seedVector, useMigrationTestPool } from './migration-test-helpers.js';

const pool = useMigrationTestPool({ beforeEach, afterAll });

const USER = 'u-itest';

function memoryInput(overrides: Partial<StoreMemoryInput> = {}): StoreMemoryInput {
  return {
    userId: USER,
    content: 'integration memory',
    embedding: seedVector(1),
    importance: 0.5,
    sourceSite: 'integration-test',
    status: 'active',
    ...overrides,
  };
}

async function migrateToHead(): Promise<void> {
  await applyLegacySchema(pool);
  await migrate({ pool });
}

describe('external_id idempotency invariant (real Postgres)', () => {
  it('rejects a second LIVE row sharing (user_id, externalId) with 23505', async () => {
    await migrateToHead();
    await storeMemory(pool, memoryInput({ content: 'v1', metadata: { externalId: 'atom-1' } }));
    await expect(
      storeMemory(pool, memoryInput({ content: 'v2', metadata: { externalId: 'atom-1' } })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('does not constrain rows that carry no externalId', async () => {
    await migrateToHead();
    const first = await storeMemory(pool, memoryInput({ content: 'n1' }));
    const second = await storeMemory(pool, memoryInput({ content: 'n2' }));
    expect(first).not.toBe(second);
  });

  it('allows the same externalId for a different user', async () => {
    await migrateToHead();
    await storeMemory(pool, memoryInput({ content: 'a', metadata: { externalId: 'shared' } }));
    const otherUser = await storeMemory(
      pool,
      memoryInput({ userId: 'u-other', content: 'b', metadata: { externalId: 'shared' } }),
    );
    expect(otherUser).toBeTruthy();
  });

  it('resolves a stored memory by its external id via the real read path', async () => {
    await migrateToHead();
    const id = await storeMemory(
      pool,
      memoryInput({ content: 'hello', metadata: { externalId: 'atom-9' } }),
    );
    const found = await findMemoryByExternalId(pool, USER, 'atom-9');
    expect(found?.id).toBe(id);
    expect(found?.content).toBe('hello');
  });
});
