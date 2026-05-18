import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithMemory } from './run-with-memory.js';
import { makeFakeClient, makeMemory } from './test-fixtures.js';

const scope = { user: 'u1' };

test('runs with augmented input and ingests the result', async () => {
  const fake = makeFakeClient({
    searchResults: [makeMemory('project uses strict TypeScript')],
  });

  const result = await runWithMemory({
    client: fake.client,
    input: 'what should I use?',
    scope,
    async run(input) {
      assert.equal((input[0] as { role?: string }).role, 'system');
      return { finalOutput: 'Use TypeScript.' };
    },
  });

  assert.equal(result.retrieved.length, 1);
  assert.equal(result.ingestResult?.created[0], 'fake-id');
  assert.equal(fake.searchCalls.length, 1);
  assert.equal(fake.ingestCalls.length, 1);
});

test('can skip post-run ingestion', async () => {
  const fake = makeFakeClient();
  await runWithMemory({
    client: fake.client,
    input: 'hello',
    scope,
    ingestOnFinish: false,
    async run() {
      return { finalOutput: 'hi' };
    },
  });
  assert.equal(fake.ingestCalls.length, 0);
});
