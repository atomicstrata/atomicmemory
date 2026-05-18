import { MemoryClient } from '@atomicmemory/sdk';
import { augmentInputWithMemory, runWithMemory } from '../dist/index.js';
import { userInfo } from 'node:os';

const apiUrl = 'http://127.0.0.1:3050';
const provider = process.env.ATOMICMEMORY_PROVIDER || 'atomicmemory';

if (provider !== 'atomicmemory' && provider !== 'mem0') {
  throw new Error(`Unsupported ATOMICMEMORY_PROVIDER: ${provider}`);
}

const providers =
  provider === 'mem0'
    ? { mem0: { apiUrl } }
    : { atomicmemory: { apiUrl } };

const client = new MemoryClient({ providers, defaultProvider: provider });
await client.initialize();

const scope = {
  user: process.env.ATOMICMEMORY_SCOPE_USER || userInfo().username || 'local-machine',
  namespace:
    process.env.ATOMICMEMORY_SCOPE_NAMESPACE || 'openai-agents-sdk-smoke',
};
const marker = `openai-agents-sdk-smoke-${Date.now()}`;
const content = `AtomicMemory OpenAI Agents SDK smoke fact: marker ${marker}.`;

await client.ingest(
  provider === 'atomicmemory'
    ? {
        mode: 'verbatim',
        content,
        kind: 'fact',
        scope,
        metadata: { source: 'openai-agents-sdk-smoke', marker },
      }
    : {
        mode: 'text',
        content,
        scope,
        metadata: { source: 'openai-agents-sdk-smoke', marker },
      },
);

const augmented = await augmentInputWithMemory(client, {
  scope,
  query: marker,
  input: `What is the smoke marker ${marker}?`,
  limit: 5,
});

const found = augmented.retrieved.some((result) =>
  result.memory.content.includes(marker),
);

console.log(
  JSON.stringify(
    {
      phase: 'augment',
      marker,
      retrieved: augmented.retrieved.length,
      found,
    },
    null,
    2,
  ),
);

if (!found) {
  console.log(
    JSON.stringify(
      {
        retrievedContents: augmented.retrieved.map((result) => result.memory.content),
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const wrapped = await runWithMemory({
  client,
  scope,
  input: `Confirm marker ${marker}`,
  search: { query: marker },
  ingest: {
    metadata: {
      source: 'openai-agents-sdk-smoke',
      event: 'fake_run_completed',
      marker,
    },
  },
  async run(input) {
    return {
      finalOutput: `Confirmed marker ${marker}. Input items: ${input.length}`,
    };
  },
});

console.log(
  JSON.stringify(
    {
      phase: 'runWithMemory',
      retrieved: wrapped.retrieved.length,
      created: wrapped.ingestResult?.created?.length ?? 0,
      updated: wrapped.ingestResult?.updated?.length ?? 0,
      unchanged: wrapped.ingestResult?.unchanged?.length ?? 0,
    },
    null,
    2,
  ),
);
