/**
 * @file Wiring test: the entity tools (entity_profile / entity_attributes) must
 * route through the scope-lock guard in `dispatch`. Regression for the AGNT-002
 * follow-up where these tools took an arbitrary entityId and bypassed scope
 * enforcement entirely. Uses a fake EntitiesClient to prove the guard fires
 * BEFORE any cross-tenant read reaches the entities backend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from './server.js';
import type { EntitiesClient } from '@atomicmemory/sdk';

function makeFakeEntities(): { entities: EntitiesClient; calls: string[] } {
  const calls: string[] = [];
  const entities = {
    async profile(id: string) { calls.push(`profile:${id}`); return { id }; },
    async attributes(id: string) { calls.push(`attributes:${id}`); return { id, attributes: [] }; },
  } as unknown as EntitiesClient;
  return { entities, calls };
}

const HANDLERS = {} as never;
const LOCK = { defaultScope: { user: 'server-user' }, scopeLock: true };

test('dispatch — scopeLock blocks entity_profile for a cross-scope entityId (guard fires, backend untouched)', async () => {
  const { entities, calls } = makeFakeEntities();
  await assert.rejects(
    () => dispatch(HANDLERS, entities, 'entity_profile', { entityId: 'victim', entityType: 'user' }, LOCK),
    /lock/i,
  );
  assert.deepEqual(calls, []);
});

test('dispatch — scopeLock blocks entity_attributes for a cross-scope entityId', async () => {
  const { entities, calls } = makeFakeEntities();
  await assert.rejects(
    () => dispatch(HANDLERS, entities, 'entity_attributes', { entityId: 'victim' }, LOCK),
    /lock/i,
  );
  assert.deepEqual(calls, []);
});

test('dispatch — scopeLock allows entity_profile for the server-default user', async () => {
  const { entities, calls } = makeFakeEntities();
  await dispatch(HANDLERS, entities, 'entity_profile', { entityId: 'server-user', entityType: 'user' }, LOCK);
  assert.deepEqual(calls, ['profile:server-user']);
});

test('dispatch — without scopeLock entity_profile allows any entityId (multi-user default)', async () => {
  const { entities, calls } = makeFakeEntities();
  await dispatch(HANDLERS, entities, 'entity_profile', { entityId: 'anyone' }, { defaultScope: { user: 'server-user' }, scopeLock: false });
  assert.deepEqual(calls, ['profile:anyone']);
});
