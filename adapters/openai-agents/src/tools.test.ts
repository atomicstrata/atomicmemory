import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from './tools.js';
import { makeFakeClient } from './test-fixtures.js';

const scope = { user: 'u1' };

test('creates memory_search and memory_ingest tools', () => {
  const fake = makeFakeClient();
  const tools = createMemoryTools(fake.client, { scope });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['memory_search', 'memory_ingest'],
  );
});
