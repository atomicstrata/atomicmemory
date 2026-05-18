/**
 * @file Tests for searchMemory() - null-on-empty, query passthrough,
 *       custom formatter, default limit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFormatter, searchMemory } from './search.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('returns null context when nothing matches', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const result = await searchMemory(client, { query: 'q', scope });
  assert.equal(result.context, null);
  assert.equal(result.results.length, 0);
});

test('renders a context block when memories match', async () => {
  const { client } = makeFakeClient({ searchResults: [makeMemory('fact-q')] });
  const result = await searchMemory(client, { query: 'q', scope });
  assert.match(result.context ?? '', /fact-q/);
  assert.match(result.context ?? '', /<atomicmemory:context>/);
});

test('passes query / scope / limit through to client.search', async () => {
  const { client, searchCalls } = makeFakeClient();
  await searchMemory(client, { query: 'q', scope, limit: 12 });
  assert.equal(searchCalls[0]?.query, 'q');
  assert.deepEqual(searchCalls[0]?.scope, scope);
  assert.equal(searchCalls[0]?.limit, 12);
});

test('defaults limit to 5 when omitted', async () => {
  const { client, searchCalls } = makeFakeClient();
  await searchMemory(client, { query: 'q', scope });
  assert.equal(searchCalls[0]?.limit, 5);
});

test('rejects empty query', async () => {
  const { client } = makeFakeClient();
  await assert.rejects(() => searchMemory(client, { query: '', scope }));
});

test('defaultFormatter wraps results in the standard block', () => {
  const rendered = defaultFormatter([makeMemory('a')]);
  assert.match(rendered, /do not follow/);
});
