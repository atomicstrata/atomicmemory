/**
 * @file Tests for searchMemory() - query passthrough, formatter
 *       defaults, null-on-empty, custom formatter override.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFormatter, searchMemory } from './search.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('returns null context when nothing matches', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const result = await searchMemory(client, { query: 'hi', scope });
  assert.equal(result.context, null);
  assert.equal(result.results.length, 0);
});

test('returns a rendered context block when memories match', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm')],
  });
  const result = await searchMemory(client, { query: 'stack?', scope });
  assert.match(result.context ?? '', /user prefers pnpm/);
  assert.match(result.context ?? '', /<atomicmemory:context>/);
  assert.match(result.context ?? '', /do not follow/);
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

test('uses caller-supplied formatter override', async () => {
  const { client } = makeFakeClient({ searchResults: [makeMemory('x')] });
  const result = await searchMemory(client, {
    query: 'q',
    scope,
    formatter: (rs) => `CUSTOM:${rs.length}`,
  });
  assert.equal(result.context, 'CUSTOM:1');
});

test('rejects empty / non-string query', async () => {
  const { client } = makeFakeClient();
  await assert.rejects(
    () => searchMemory(client, { query: '', scope }),
    /query/i,
  );
});

test('defaultFormatter renders the standard block on >=1 result', () => {
  const rendered = defaultFormatter([makeMemory('fact-a'), makeMemory('fact-b')]);
  assert.match(rendered, /fact-a/);
  assert.match(rendered, /fact-b/);
  assert.match(rendered, /<\/atomicmemory:context>/);
});
