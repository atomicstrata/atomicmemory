/**
 * @file Tests for ingestTurn — role filtering + completion append.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestTurn } from './ingest.js';
import { makeFakeClient } from './test-fixtures.js';

const scope = { user: 'u1' };

function lastIngestMessages(ingest: {
  ingestCalls: Array<{ messages?: Array<{ role: string; content: string }> }>;
}): Array<{ role: string; content: string }> {
  const call = ingest.ingestCalls[ingest.ingestCalls.length - 1];
  return call?.messages ?? [];
}

test('excludes system messages by default', async () => {
  const fake = makeFakeClient();
  await ingestTurn(fake.client, {
    messages: [
      { role: 'system', content: 'hidden policy' },
      { role: 'user', content: 'hi' },
    ],
    completion: 'hello',
    scope,
  });

  const msgs = lastIngestMessages(fake);
  assert.equal(msgs.length, 2);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(
    msgs.find((m) => m.role === 'system'),
    undefined,
  );
});

test('includes user, assistant, and tool roles by default', async () => {
  const fake = makeFakeClient();
  await ingestTurn(fake.client, {
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool', content: '{"result":42}' },
    ],
    completion: 'final',
    scope,
  });

  const msgs = lastIngestMessages(fake);
  assert.equal(msgs.length, 4);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
});

test('honors explicit includeRoles override', async () => {
  const fake = makeFakeClient();
  await ingestTurn(fake.client, {
    messages: [
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'q' },
    ],
    completion: 'a',
    scope,
    includeRoles: ['system', 'user'],
  });

  const msgs = lastIngestMessages(fake);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ['system', 'user', 'assistant'],
  );
});

test('appends completion as a trailing assistant message', async () => {
  const fake = makeFakeClient();
  await ingestTurn(fake.client, {
    messages: [{ role: 'user', content: 'q' }],
    completion: 'THE RESPONSE',
    scope,
  });

  const msgs = lastIngestMessages(fake);
  const last = msgs[msgs.length - 1];
  assert.equal(last?.role, 'assistant');
  assert.equal(last?.content, 'THE RESPONSE');
});
