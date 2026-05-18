/**
 * @file Tests for createMemoryTools() - id discipline, scope
 *       binding, no-results sentinel, default-limit precedence,
 *       and ingest delegation through the Mastra tool surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from './tools.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

async function invokeTool<T>(
  tool: { execute?: (input: any, ctx: any) => Promise<any> },
  input: T,
): Promise<unknown> {
  if (!tool.execute) throw new Error('tool has no execute fn');
  return tool.execute(input, {});
}

test('produces tools with stable ids', () => {
  const { client } = makeFakeClient();
  const { searchTool, ingestTool } = createMemoryTools(client, { scope });
  assert.equal(searchTool.id, 'memory_search');
  assert.equal(ingestTool.id, 'memory_ingest');
});

test('search tool returns the rendered context on hit', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm')],
  });
  const { searchTool } = createMemoryTools(client, { scope });
  const out = (await invokeTool(searchTool, { query: 'stack?' })) as { context: string };
  assert.match(out.context, /user prefers pnpm/);
  assert.match(out.context, /<atomicmemory:context>/);
});

test('search tool returns the fixed no-memories sentinel on miss', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const { searchTool } = createMemoryTools(client, { scope });
  const out = (await invokeTool(searchTool, { query: 'q' })) as { context: string };
  assert.equal(out.context, 'no relevant memories found');
});

test('search tool binds scope at factory time (agent cannot rebind)', async () => {
  const { client, searchCalls } = makeFakeClient();
  const fixedScope = { user: 'pip', namespace: 'demo' };
  const { searchTool } = createMemoryTools(client, { scope: fixedScope });
  await invokeTool(searchTool, { query: 'q' });
  assert.deepEqual(searchCalls[0]?.scope, fixedScope);
});

test('search tool prefers caller limit over factory defaultLimit', async () => {
  const { client, searchCalls } = makeFakeClient();
  const { searchTool } = createMemoryTools(client, { scope, defaultLimit: 3 });
  await invokeTool(searchTool, { query: 'q', limit: 9 });
  assert.equal(searchCalls[0]?.limit, 9);
});

test('search tool falls back to factory defaultLimit when caller omits limit', async () => {
  const { client, searchCalls } = makeFakeClient();
  const { searchTool } = createMemoryTools(client, { scope, defaultLimit: 3 });
  await invokeTool(searchTool, { query: 'q' });
  assert.equal(searchCalls[0]?.limit, 3);
});

test('ingest tool delegates to client.ingest in text mode with scope', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const { ingestTool } = createMemoryTools(client, { scope });
  const out = (await invokeTool(ingestTool, { content: 'fact' })) as { created: number; updated: number };
  const sent = ingestCalls[0];
  assert.equal(sent?.mode, 'text');
  assert.equal(sent?.mode === 'text' && sent.content, 'fact');
  assert.deepEqual(sent?.scope, scope);
  assert.equal(out.created, 1);
  assert.equal(out.updated, 0);
});
