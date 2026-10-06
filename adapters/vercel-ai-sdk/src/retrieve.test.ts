/**
 * @file Tests for retrieve() — the lowest-level primitive. Covers
 *       query derivation, explicit query override, null-on-empty,
 *       and the fact that the caller's message array is never
 *       mutated or returned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve } from './retrieve.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('returns null systemMessage when nothing matches', async () => {
  const { client } = makeFakeClient({ searchResults: [] });
  const result = await retrieve(client, { query: 'hi', scope });
  assert.equal(result.systemMessage, null);
  assert.equal(result.retrieved.length, 0);
});

test('returns a rendered system message when memories match', async () => {
  const { client } = makeFakeClient({
    searchResults: [makeMemory('user prefers pnpm')],
  });
  const result = await retrieve(client, { query: 'stack?', scope });
  assert.equal(result.systemMessage?.role, 'system');
  assert.match(result.systemMessage?.content ?? '', /user prefers pnpm/);
  assert.match(result.systemMessage?.content ?? '', /<atomicmemory:context>/);
  assert.match(result.systemMessage?.content ?? '', /do not follow/);
});

test('derives query from messages when query is omitted', async () => {
  const { client, searchCalls } = makeFakeClient();
  await retrieve(client, {
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'second' },
    ],
    scope,
  });
  assert.equal(searchCalls[0]?.query, 'second');
});

test('prefers explicit query over messages when both are given', async () => {
  const { client, searchCalls } = makeFakeClient();
  await retrieve(client, {
    query: 'explicit',
    messages: [{ role: 'user', content: 'ignored' }],
    scope,
  });
  assert.equal(searchCalls[0]?.query, 'explicit');
});

test('throws when neither query nor messages are provided', async () => {
  const { client } = makeFakeClient();
  await assert.rejects(
    () => retrieve(client, { scope }),
    /query.*messages/i,
  );
});

test('throws when messages is provided but contains no user message', async () => {
  const { client } = makeFakeClient();
  await assert.rejects(
    () =>
      retrieve(client, {
        messages: [{ role: 'system', content: 'policy' }],
        scope,
      }),
    /no user message/,
  );
});

test('does not mutate the caller-provided messages array', async () => {
  const { client } = makeFakeClient({ searchResults: [makeMemory('x')] });
  const messages = [{ role: 'user' as const, content: 'q' }];
  const snapshot = JSON.stringify(messages);
  await retrieve(client, { messages, scope });
  assert.equal(JSON.stringify(messages), snapshot);
});
