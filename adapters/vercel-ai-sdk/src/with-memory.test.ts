/**
 * @file Tests for withMemory — composition of augment + ingest around
 *       a caller-supplied run function.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withMemory } from './with-memory.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('augments then ingests by default', async () => {
  const fake = makeFakeClient({ searchResults: [makeMemory('fact')] });
  let seenMessageCount = 0;

  const result = await withMemory({
    client: fake.client,
    scope,
    messages: [{ role: 'user', content: 'q' }],
    async run(augmented) {
      seenMessageCount = augmented.length;
      return { text: 'completion' };
    },
  });

  assert.equal(seenMessageCount, 2); // system + user
  assert.equal(result.text, 'completion');
  assert.equal(result.retrieved.length, 1);
  assert.equal(fake.ingestCalls.length, 1);
});

test('skips ingest when ingestOnFinish is false', async () => {
  const fake = makeFakeClient();

  await withMemory({
    client: fake.client,
    scope,
    messages: [{ role: 'user', content: 'q' }],
    ingestOnFinish: false,
    async run() {
      return { text: 'x' };
    },
  });

  assert.equal(fake.ingestCalls.length, 0);
});

test('passes additional run result fields through', async () => {
  const fake = makeFakeClient();

  const result = await withMemory<{ usage: { tokens: number } }>({
    client: fake.client,
    scope,
    messages: [{ role: 'user', content: 'q' }],
    async run() {
      return { text: 'hi', usage: { tokens: 42 } };
    },
  });

  assert.equal(result.usage.tokens, 42);
  assert.equal(result.text, 'hi');
});

test('ingest uses original messages, not augmented ones', async () => {
  const fake = makeFakeClient({ searchResults: [makeMemory('x')] });
  const original = [{ role: 'user' as const, content: 'q' }];

  await withMemory({
    client: fake.client,
    scope,
    messages: original,
    async run() {
      return { text: 'a' };
    },
  });

  const call = fake.ingestCalls[0];
  assert.ok(call);
  if (call.mode !== 'messages') throw new Error('expected messages mode');
  // user + assistant completion. System from augment should NOT be included.
  assert.equal(call.messages.length, 2);
  assert.equal(call.messages[0]?.role, 'user');
  assert.equal(call.messages[1]?.role, 'assistant');
});
