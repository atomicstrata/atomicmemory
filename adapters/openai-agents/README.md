# AtomicMemory for OpenAI Agents SDK

Adapter for the [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/). It wires AtomicMemory into agent runs without replacing the SDK's own `Session` implementations.

## Install

This package is intended to publish as `@atomicmemory/openai-agents`. Until
`@atomicmemory/sdk` is published and pinned to a registry version, build it
from the monorepo:

```bash
pnpm --filter @atomicmemory/openai-agents build
```

In a local workspace, import from the package once it is linked by `pnpm-workspace.yaml`:

```ts
import { MemoryClient } from '@atomicmemory/sdk';
import { Agent, run } from '@openai/agents';
import { runWithMemory } from '@atomicmemory/openai-agents';

const memory = new MemoryClient({
  providers: {
    atomicmemory: {
      apiUrl: process.env.ATOMICMEMORY_API_URL!,
      apiKey: process.env.ATOMICMEMORY_API_KEY,
    },
  },
  defaultProvider: 'atomicmemory',
});
await memory.initialize();

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
});

const { result, retrieved } = await runWithMemory({
  client: memory,
  scope: { user: 'user-123', namespace: 'support' },
  input: 'What did we decide about billing retries?',
  run: (input) => run(agent, input),
});

console.log(result.finalOutput, retrieved.length);
```

## Primitives

### `augmentInputWithMemory(client, options)`

Searches AtomicMemory before an agent run and prepends a `system()` message containing retrieved context when matches exist.

```ts
const { input, retrieved } = await augmentInputWithMemory(memory, {
  scope: { user: 'user-123' },
  input: 'What should I remember?',
});

const result = await run(agent, input);
```

### `ingestAgentTurn(client, options)`

Persists completed turns after `run()`. System messages are excluded by default; the assistant output is appended as the final assistant message.

```ts
await ingestAgentTurn(memory, {
  scope: { user: 'user-123' },
  input,
  result,
  metadata: { source: 'openai-agents', event: 'run_completed' },
});
```

For streamed results, wait for `completed` and pass explicit output text if needed:

```ts
const stream = await run(agent, input, { stream: true });
await stream.completed;

await ingestAgentTurn(memory, {
  scope,
  input,
  output: String(stream.finalOutput ?? ''),
});
```

### `createMemoryTools(client, options)`

Creates two OpenAI Agents SDK function tools:

- `memory_search` - search AtomicMemory during a run.
- `memory_ingest` - store durable preferences, decisions, conventions, or facts.

```ts
const agent = new Agent({
  name: 'Assistant',
  instructions: 'Use memory tools when prior context or durable learning matters.',
  tools: createMemoryTools(memory, {
    scope: { user: 'user-123', namespace: 'support' },
    metadata: { source: 'openai-agents-tool' },
  }),
});
```

## Verify

Run local adapter checks:

```bash
pnpm --filter @atomicmemory/openai-agents test
pnpm --filter @atomicmemory/openai-agents typecheck
pnpm --filter @atomicmemory/openai-agents build
```

Run the backend smoke test without making an OpenAI API call:

```bash
export ATOMICMEMORY_API_URL="http://localhost:3050"
export ATOMICMEMORY_API_KEY="..."
export ATOMICMEMORY_PROVIDER="atomicmemory"
export ATOMICMEMORY_SCOPE_USER="$USER"
export ATOMICMEMORY_SCOPE_NAMESPACE="openai-agents-sdk-smoke"

pnpm --filter @atomicmemory/openai-agents smoke:backend
```

The smoke test writes a unique marker, verifies `augmentInputWithMemory()` retrieves it, then runs `runWithMemory()` with a fake runner and reports the post-run ingest AUDN-SC outcome.

Set `OPENAI_API_KEY` only when you want to test the real `Agent + run()` path from the install example.

## Notes

- AtomicMemory is long-term semantic memory. The OpenAI Agents SDK `Session` surface is still useful for short-term conversation state.
- Retrieved memories are injected as reference context only. The adapter's default prompt explicitly tells the model not to follow instructions embedded in retrieved memories.
- `ingestAgentTurn` requires text output. For structured outputs, it serializes `finalOutput` as JSON unless you pass an explicit `output`.

## License

Apache-2.0.
