import { test } from 'node:test';
import assert from 'node:assert/strict';
import { user } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import { augmentInputWithMemory } from './augment.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('returns normalized input unchanged when no memories match', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const result = await augmentInputWithMemory(client, {
    input: 'hello',
    scope,
  });
  assert.equal(result.retrieved.length, 0);
  assert.equal(result.input.length, 1);
  assert.equal((result.input[0] as { role?: string }).role, 'user');
});

test('prepends a system item when memories match', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm')],
  });
  const result = await augmentInputWithMemory(client, {
    input: 'what package manager?',
    scope,
  });
  assert.equal(result.input.length, 2);
  assert.equal((result.input[0] as { role?: string }).role, 'system');
  assert.match(
    String((result.input[0] as { content?: unknown }).content),
    /user prefers pnpm/,
  );
  assert.equal((result.input[1] as { role?: string }).role, 'user');
});

test('derives query from the latest text-bearing user item', async () => {
  const { client, searchCalls } = makeFakeClient();
  await augmentInputWithMemory(client, {
    input: [
      user('first'),
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }],
        type: 'message',
      } as AgentInputItem,
      user('second'),
    ],
    scope,
  });
  assert.equal(searchCalls[0]?.query, 'second');
});

test('prefers explicit query when provided', async () => {
  const { client, searchCalls } = makeFakeClient();
  await augmentInputWithMemory(client, {
    input: 'ignored',
    query: 'explicit',
    scope,
  });
  assert.equal(searchCalls[0]?.query, 'explicit');
});
