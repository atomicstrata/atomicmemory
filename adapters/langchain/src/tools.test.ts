/**
 * @file Tests for createMemoryTools() - name + description
 *       discipline, scope-binding invariance, no-results path,
 *       defaultLimit + caller-limit precedence, ingest delegation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from './tools.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('produces tools with stable names', () => {
  const { client } = makeFakeClient();
  const { searchTool, ingestTool } = createMemoryTools(client, { scope });
  assert.equal(searchTool.name, 'memory_search');
  assert.equal(ingestTool.name, 'memory_ingest');
});

test('search tool returns the rendered context on hit', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm')],
  });
  const { searchTool } = createMemoryTools(client, { scope });
  const out = (await searchTool.invoke({ query: 'stack?' })) as string;
  assert.match(out, /user prefers pnpm/);
  assert.match(out, /<atomicmemory:context>/);
});

test('search tool returns a fixed no-memories sentinel on miss', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const { searchTool } = createMemoryTools(client, { scope });
  const out = (await searchTool.invoke({ query: 'q' })) as string;
  assert.equal(out, 'no relevant memories found');
});

test('search tool binds scope at factory time (agent cannot rebind)', async () => {
  const { client, searchCalls } = makeFakeClient();
  const fixedScope = { user: 'pip', namespace: 'demo' };
  const { searchTool } = createMemoryTools(client, { scope: fixedScope });
  await searchTool.invoke({ query: 'q' });
  assert.deepEqual(searchCalls[0]?.scope, fixedScope);
});

test('search tool prefers caller limit over factory defaultLimit', async () => {
  const { client, searchCalls } = makeFakeClient();
  const { searchTool } = createMemoryTools(client, { scope, defaultLimit: 3 });
  await searchTool.invoke({ query: 'q', limit: 9 });
  assert.equal(searchCalls[0]?.limit, 9);
});

test('search tool falls back to factory defaultLimit when caller omits limit', async () => {
  const { client, searchCalls } = makeFakeClient();
  const { searchTool } = createMemoryTools(client, { scope, defaultLimit: 3 });
  await searchTool.invoke({ query: 'q' });
  assert.equal(searchCalls[0]?.limit, 3);
});

test('ingest tool delegates to client.ingest in text mode with scope', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const { ingestTool } = createMemoryTools(client, { scope });
  const out = (await ingestTool.invoke({ content: 'fact' })) as string;
  const sent = ingestCalls[0];
  assert.equal(sent?.mode, 'text');
  assert.equal(sent?.mode === 'text' && sent.content, 'fact');
  assert.deepEqual(sent?.scope, scope);
  assert.match(out, /ingested/);
});

test('search tool rejects empty query at schema layer', async () => {
  const { client } = makeFakeClient();
  const { searchTool } = createMemoryTools(client, { scope });
  await assert.rejects(() => searchTool.invoke({ query: '' }));
});
