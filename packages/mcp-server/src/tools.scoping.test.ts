/**
 * @file Tests for sourceSite routing on memory_search / memory_package /
 *       memory_list, plus the new memory_list tool.
 *
 * Contract: when the caller passes `sourceSite`, the handler dispatches
 * through `client.atomicmemory.*` (the AtomicMemory namespace handle that
 * natively supports sourceSite). When `sourceSite` is absent, the V3
 * generic methods are used. If `sourceSite` is set but `client.atomicmemory`
 * is unavailable (e.g. provider=mem0), the handler throws an error with
 * code `PROVIDER_UNSUPPORTED` rather than silently dropping the filter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from './tools.js';
import type { MemoryClient } from '@atomicmemory/sdk';

interface AtomicCall {
  method: 'search' | 'list';
  request: unknown;
  scope: unknown;
}

interface GenericCall {
  method: 'search' | 'package' | 'list';
  args: unknown;
}

interface FakeClient {
  client: MemoryClient;
  atomicCalls: AtomicCall[];
  genericCalls: GenericCall[];
}

interface FakeOptions {
  hasAtomicMemory?: boolean;
}

function makeFake(options: FakeOptions = {}): FakeClient {
  const atomicCalls: AtomicCall[] = [];
  const genericCalls: GenericCall[] = [];
  const hasAtomicMemory = options.hasAtomicMemory ?? true;

  const atomicHandle = {
    async search(request: unknown, scope: unknown) {
      atomicCalls.push({ method: 'search', request, scope });
      return { count: 0, results: [], retrievalMode: 'tiered', scope } as unknown;
    },
    async list(scope: unknown, opts: unknown) {
      atomicCalls.push({ method: 'list', request: opts, scope });
      return { memories: [], count: 0 } as unknown;
    },
  };

  const client = {
    async search(args: unknown) {
      genericCalls.push({ method: 'search', args });
      return { results: [] } as unknown;
    },
    async package(args: unknown) {
      genericCalls.push({ method: 'package', args });
      return { text: '', results: [], tokens: 0 } as unknown;
    },
    async list(args: unknown) {
      genericCalls.push({ method: 'list', args });
      return { memories: [], count: 0 } as unknown;
    },
    atomicmemory: hasAtomicMemory ? atomicHandle : undefined,
  } as unknown as MemoryClient;

  return { client, atomicCalls, genericCalls };
}

const SCOPE = { user: 'u-1' };

test('memory_search — no sourceSite routes through V3 generic client.search', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_search({ query: 'q', scope: SCOPE, limit: 3 });

  assert.equal(fake.atomicCalls.length, 0);
  assert.equal(fake.genericCalls.length, 1);
  assert.deepEqual(fake.genericCalls[0]!.args, {
    query: 'q',
    scope: SCOPE,
    limit: 3,
  });
});

test('memory_search — sourceSite routes through atomicmemory.search with user scope', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_search({
    query: 'q',
    scope: SCOPE,
    limit: 3,
    sourceSite: 'hermes',
  });

  assert.equal(fake.genericCalls.length, 0);
  assert.equal(fake.atomicCalls.length, 1);
  const call = fake.atomicCalls[0]!;
  assert.equal(call.method, 'search');
  assert.deepEqual(call.scope, { kind: 'user', userId: 'u-1' });
  assert.deepEqual(call.request, { query: 'q', limit: 3, sourceSite: 'hermes' });
});

test('memory_search — sourceSite without atomicmemory namespace throws PROVIDER_UNSUPPORTED', async () => {
  const fake = makeFake({ hasAtomicMemory: false });
  const handlers = createHandlers(fake.client, undefined);

  let caught: (Error & { code?: string }) | undefined;
  try {
    await handlers.memory_search({ query: 'q', scope: SCOPE, sourceSite: 'hermes' });
  } catch (err) {
    caught = err as Error & { code?: string };
  }
  assert.ok(caught, 'expected memory_search to reject');
  assert.match(caught.message, /AtomicMemory provider/);
  assert.equal(caught.code, 'PROVIDER_UNSUPPORTED');
  assert.equal(fake.atomicCalls.length, 0);
  assert.equal(fake.genericCalls.length, 0);
});

test('memory_package — no sourceSite routes through V3 generic client.package', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_package({ query: 'q', scope: SCOPE, tokenBudget: 1500 });

  assert.equal(fake.atomicCalls.length, 0);
  assert.deepEqual(fake.genericCalls[0]!.args, {
    query: 'q',
    scope: SCOPE,
    tokenBudget: 1500,
  });
});

test('memory_package — sourceSite routes through atomicmemory.search with retrievalMode=tiered + skipRepair', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_package({
    query: 'q',
    scope: SCOPE,
    tokenBudget: 1500,
    sourceSite: 'hermes',
  });

  assert.equal(fake.genericCalls.length, 0);
  const call = fake.atomicCalls[0]!;
  assert.equal(call.method, 'search');
  assert.deepEqual(call.scope, { kind: 'user', userId: 'u-1' });
  // `client.atomicmemory.package(...)` does not exist — packaging rides on
  // the search(...) handle. skipRepair=true matches the v1 package call.
  assert.deepEqual(call.request, {
    query: 'q',
    retrievalMode: 'tiered',
    skipRepair: true,
    tokenBudget: 1500,
    sourceSite: 'hermes',
  });
});

test('memory_package — sourceSite without atomicmemory namespace throws PROVIDER_UNSUPPORTED', async () => {
  const fake = makeFake({ hasAtomicMemory: false });
  const handlers = createHandlers(fake.client, undefined);

  let caught: (Error & { code?: string }) | undefined;
  try {
    await handlers.memory_package({ query: 'q', scope: SCOPE, sourceSite: 'hermes' });
  } catch (err) {
    caught = err as Error & { code?: string };
  }
  assert.ok(caught, 'expected memory_package to reject');
  assert.equal(caught.code, 'PROVIDER_UNSUPPORTED');
});

test('memory_list — no sourceSite routes through V3 generic client.list', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_list({ scope: SCOPE, limit: 5 });

  assert.equal(fake.atomicCalls.length, 0);
  assert.deepEqual(fake.genericCalls[0]!.args, { scope: SCOPE, limit: 5 });
});

test('memory_list — sourceSite routes through atomicmemory.list with user scope', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  await handlers.memory_list({ scope: SCOPE, limit: 5, sourceSite: 'hermes' });

  assert.equal(fake.genericCalls.length, 0);
  const call = fake.atomicCalls[0]!;
  assert.equal(call.method, 'list');
  assert.deepEqual(call.scope, { kind: 'user', userId: 'u-1' });
  assert.deepEqual(call.request, { limit: 5, sourceSite: 'hermes' });
});

test('memory_list — sourceSite without atomicmemory namespace throws PROVIDER_UNSUPPORTED', async () => {
  const fake = makeFake({ hasAtomicMemory: false });
  const handlers = createHandlers(fake.client, undefined);

  let caught: (Error & { code?: string }) | undefined;
  try {
    await handlers.memory_list({ scope: SCOPE, sourceSite: 'hermes' });
  } catch (err) {
    caught = err as Error & { code?: string };
  }
  assert.ok(caught, 'expected memory_list to reject');
  assert.equal(caught.code, 'PROVIDER_UNSUPPORTED');
});

test('memory_search — sourceSite without scope.user throws (sourceSite is user-scope only on AtomicMemory list/search)', async () => {
  const fake = makeFake();
  const handlers = createHandlers(fake.client, undefined);

  let caught: Error | undefined;
  try {
    await handlers.memory_search({
      query: 'q',
      scope: { agent: 'a-only' },
      sourceSite: 'hermes',
    });
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, 'expected memory_search to reject when scope.user is missing');
  assert.match(caught.message, /scope\.user/);
});
