/** Verify shared setup, trusted per-user tools, and distinct Cloud and Core credentials. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createMemory } from './memory.js';
import { context, fixture, searchBody } from './tools-test-support.js';

test('a shared client binds independent users and exposes writes only when enabled', async t => {
  const http = await fixture();
  t.after(http.close);
  const memory = await createMemory({ client: http.client });
  const alice = memory.toolsForUser('alice');
  const bob = memory.toolsForUser('bob', { allowWrites: true });
  assert.deepEqual(Object.keys(alice), ['memory_search']);
  assert.deepEqual(Object.keys(memory.toolsForUser('bob', { allowWrites: false })), ['memory_search']);
  await alice.memory_search.execute?.({ query: 'drink' }, context);
  await bob.memory_ingest.execute?.({ content: 'tea' }, context);
  assert.deepEqual(http.requests.map(request => request.body.user_id), ['alice', 'bob']);
  assert.throws(() => memory.toolsForUser('project:not-a-user'), /configuration is invalid/);
});

function setCloudKey(t: TestContext, key: string): void {
  const oldKey = process.env.ATOMICMEMORY_API_KEY;
  process.env.ATOMICMEMORY_API_KEY = key;
  t.after(() => {
    if (oldKey === undefined) delete process.env.ATOMICMEMORY_API_KEY;
    else process.env.ATOMICMEMORY_API_KEY = oldKey;
  });
}

test('the explicit Cloud backend uses the SDK default endpoint and a server project key', async t => {
  setCloudKey(t, 'amc_fixture-cloud-key');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(searchBody));
  const memory = await createMemory({ backend: 'cloud' });
  assert.equal(fetch.mock.callCount(), 0);
  await memory.toolsForUser('alice').memory_search.execute?.({ query: 'drink' }, context);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, request] = fetch.mock.calls[0]!.arguments as Parameters<typeof globalThis.fetch>;
  assert.equal(String(url), 'https://api.atomicstrata.ai/v1/memories/search/fast');
  assert.equal(new Headers(request?.headers).get('authorization'), 'Bearer amc_fixture-cloud-key');
});

test('missing and mixed settings are rejected before making any request', async t => {
  setCloudKey(t, 'fixture-legacy-core-key');
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Invalid setup must not fetch.');
  });
  const core = { url: 'http://127.0.0.1:17350', apiKey: 'fixture-core-key' };
  await assert.rejects(Reflect.apply(createMemory, undefined, []), /Choose a memory backend/);
  await assert.rejects(Reflect.apply(createMemory, undefined, [core]), /Choose a memory backend/);
  await assert.rejects(Reflect.apply(createMemory, undefined, [{ backend: 'cloud', ...core }]), /require the local backend/);
  await assert.rejects(Reflect.apply(createMemory, undefined, [{ client: {}, ...core }]), /not both/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('local setup does not fall back to Cloud when URL or Core token is missing', async () => {
  await assert.rejects(createMemory({ backend: 'local', url: '', apiKey: 'core-key' }), /Core token/);
  await assert.rejects(createMemory({ backend: 'local', url: 'http://127.0.0.1:17350', apiKey: ' ' }), /Core token/);
});
