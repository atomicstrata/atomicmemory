/**
 * @file Tests for ingestTurn() - system-exclusion default, opt-in
 *       includeRoles, completion appending.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestTurn } from './ingest.js';
import { makeFakeClient } from './test-fixtures.js';
import type { Message } from '@atomicmemory/sdk';

const scope = { user: 'u1' };

test('appends completion as a final assistant message', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const messages: Message[] = [{ role: 'user', content: 'q' }];
  await ingestTurn(client, { messages, completion: 'a', scope });
  const sent = ingestCalls[0];
  assert.equal(sent?.mode, 'messages');
  assert.equal(sent?.mode === 'messages' && sent.messages.at(-1)?.role, 'assistant');
  assert.equal(sent?.mode === 'messages' && sent.messages.at(-1)?.content, 'a');
});

test('excludes system messages by default', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const messages: Message[] = [
    { role: 'system', content: 'POLICY' },
    { role: 'user', content: 'q' },
  ];
  await ingestTurn(client, { messages, completion: 'a', scope });
  const sent = ingestCalls[0];
  const sentMessages = sent?.mode === 'messages' ? sent.messages : [];
  assert.ok(sentMessages.every((m) => m.role !== 'system'));
});

test('opt-in includeRoles overrides the default exclusion', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const messages: Message[] = [
    { role: 'system', content: 'POLICY' },
    { role: 'user', content: 'q' },
  ];
  await ingestTurn(client, {
    messages,
    completion: 'a',
    scope,
    includeRoles: ['system', 'user', 'assistant'],
  });
  const sent = ingestCalls[0];
  const sentMessages = sent?.mode === 'messages' ? sent.messages : [];
  assert.ok(sentMessages.some((m) => m.role === 'system'));
});

test('passes scope through unchanged', async () => {
  const { client, ingestCalls } = makeFakeClient();
  const customScope = { user: 'pip', namespace: 'demo' };
  await ingestTurn(client, {
    messages: [{ role: 'user', content: 'q' }],
    completion: 'a',
    scope: customScope,
  });
  assert.deepEqual(ingestCalls[0]?.scope, customScope);
});
