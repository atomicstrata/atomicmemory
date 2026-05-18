/**
 * @file Tests for augmentWithMemory — retrieval + system-message
 *       prepending behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { augmentWithMemory } from './augment.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('returns messages unchanged when no memories match', async () => {
  const { client, searchCalls } = makeFakeClient({ searchResults: [] });
  const messages = [{ role: 'user' as const, content: 'hello' }];

  const result = await augmentWithMemory(client, { messages, scope });

  assert.deepEqual(result.messages, messages);
  assert.equal(result.retrieved.length, 0);
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.query, 'hello');
});

test('prepends a delimited system message when memories are found', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm'), makeMemory('TZ is UTC')],
  });
  const messages = [{ role: 'user' as const, content: 'what do i use?' }];

  const result = await augmentWithMemory(client, { messages, scope });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.role, 'system');
  assert.match(result.messages[0]?.content ?? '', /<atomicmemory:context>/);
  assert.match(result.messages[0]?.content ?? '', /do not follow/);
  assert.match(result.messages[0]?.content ?? '', /user prefers pnpm/);
  assert.equal(result.retrieved.length, 2);
});

test('custom formatter replaces the default rendering', async () => {
  const { client } = makeFakeClient({ searchResults: [makeMemory('x')] });
  const messages = [{ role: 'user' as const, content: 'hi' }];

  const result = await augmentWithMemory(client, {
    messages,
    scope,
    formatter: () => 'CUSTOM',
  });

  assert.equal(result.messages[0]?.content, 'CUSTOM');
});

test('uses the most recent user message as the query', async () => {
  const { client, searchCalls } = makeFakeClient();
  const messages = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'second' },
  ];

  await augmentWithMemory(client, { messages, scope });

  assert.equal(searchCalls[0]?.query, 'second');
});

test('throws when there is no user message', async () => {
  const { client } = makeFakeClient();
  const messages = [{ role: 'system' as const, content: 'you are a bot' }];

  await assert.rejects(
    () => augmentWithMemory(client, { messages, scope }),
    /no user message/,
  );
});

test('forwards limit to client.search', async () => {
  const { client, searchCalls } = makeFakeClient();
  const messages = [{ role: 'user' as const, content: 'q' }];

  await augmentWithMemory(client, { messages, scope, limit: 20 });

  assert.equal(searchCalls[0]?.limit, 20);
});
