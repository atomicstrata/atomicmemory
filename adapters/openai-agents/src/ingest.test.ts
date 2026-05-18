import { test } from 'node:test';
import assert from 'node:assert/strict';
import { system, user } from '@openai/agents';
import type { IngestInput } from '@atomicmemory/sdk';
import { ingestAgentTurn } from './ingest.js';
import { makeFakeClient } from './test-fixtures.js';

const scope = { user: 'u1' };

function lastIngestMessages(ingest: {
  ingestCalls: IngestInput[];
}): Array<{ role: string; content: string }> {
  const call = ingest.ingestCalls[ingest.ingestCalls.length - 1];
  if (call?.mode !== 'messages') return [];
  return call.messages;
}

test('excludes system input by default and appends final output', async () => {
  const fake = makeFakeClient();
  await ingestAgentTurn(fake.client, {
    input: [system('hidden'), user('hello')],
    result: { finalOutput: 'hi' },
    scope,
  });

  const messages = lastIngestMessages(fake);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(messages[1]?.content, 'hi');
});

test('serializes structured final output', async () => {
  const fake = makeFakeClient();
  await ingestAgentTurn(fake.client, {
    input: 'summarize',
    result: { finalOutput: { answer: 'done' } },
    scope,
  });

  const messages = lastIngestMessages(fake);
  assert.equal(messages[messages.length - 1]?.content, '{"answer":"done"}');
});

test('honors explicit output and metadata', async () => {
  const fake = makeFakeClient();
  await ingestAgentTurn(fake.client, {
    input: 'remember this',
    result: { finalOutput: 'ignored' },
    output: 'explicit',
    scope,
    metadata: { source: 'openai-agents' },
  });

  const call = fake.ingestCalls[fake.ingestCalls.length - 1];
  assert.equal(call?.mode, 'messages');
  assert.deepEqual(call?.metadata, { source: 'openai-agents' });
  assert.equal(lastIngestMessages(fake).at(-1)?.content, 'explicit');
});

test('throws when output is missing', async () => {
  const fake = makeFakeClient();
  await assert.rejects(
    () =>
      ingestAgentTurn(fake.client, {
        input: 'hello',
        result: {},
        scope,
      }),
    /assistant output is required/,
  );
});
