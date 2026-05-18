/**
 * @file Adapter registry tests. Phase 5 commands route through
 * `getAdapter(profile)`; the routing decision must depend only on
 * `profile.provider`, with optional `factories` injection so tests
 * can substitute fake clients without touching the network.
 *
 * The registry is async (lazy SDK import) per the Phase 5 audit so
 * non-provider commands (`version`, `help`, etc.) never trigger SDK
 * module-load side effects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../adapters/registry.js';
import { AtomicMemoryAdapter } from '../adapters/atomicmemory.js';
import { Mem0Adapter } from '../adapters/mem0.js';
import type { CliProfileShape } from '../config/schema.js';
import type { MemoryClient } from '@atomicmemory/sdk';

const baseProfile: CliProfileShape = {
  provider: 'atomicmemory',
  apiUrl: 'http://localhost:3050',
  trustSurface: 'local',
};

function fakeClient(): MemoryClient {
  return {
    initialize: async () => {},
    getProviderStatus: () => [],
    capabilities: () => ({
      ingestModes: ['text'],
      requiredScope: { default: ['user'] },
      extensions: {
        update: false,
        package: false,
        temporal: false,
        graph: false,
        forget: false,
        profile: false,
        reflect: false,
        versioning: false,
        batch: false,
        health: false,
      },
    }),
  } as unknown as MemoryClient;
}

test('getAdapter returns AtomicMemoryAdapter for provider="atomicmemory"', async () => {
  const a = await getAdapter(baseProfile, { atomicmemory: fakeClient });
  assert.ok(a instanceof AtomicMemoryAdapter);
  assert.equal(a.providerName, 'atomicmemory');
});

test('getAdapter returns Mem0Adapter for provider="mem0"', async () => {
  const profile: CliProfileShape = {
    ...baseProfile,
    provider: 'mem0',
    trustSurface: 'authenticated-wrapper',
  };
  const a = await getAdapter(profile, { mem0: fakeClient });
  assert.ok(a instanceof Mem0Adapter);
  assert.equal(a.providerName, 'mem0');
});

test('getAdapter forwards factories so each adapter sees its injected fake', async () => {
  let mem0Called = 0;
  let amCalled = 0;
  await getAdapter(baseProfile, {
    atomicmemory: () => {
      amCalled += 1;
      return fakeClient();
    },
  });
  await getAdapter(
    { ...baseProfile, provider: 'mem0', trustSurface: 'authenticated-wrapper' },
    {
      mem0: () => {
        mem0Called += 1;
        return fakeClient();
      },
    },
  );
  assert.equal(amCalled, 1);
  assert.equal(mem0Called, 1);
});
