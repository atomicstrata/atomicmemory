# @atomicmemory/mastra

AtomicMemory adapter for [Mastra](https://mastra.ai/). Memory tools and framework-agnostic helpers around an injected `MemoryClient` from `@atomicmemory/sdk`.

| Surface | Use when |
|---|---|
| `createMemoryTools()` | You want AtomicMemory as agent-callable Mastra tools (`memory_search`, `memory_ingest`). |
| `searchMemory()` / `ingestTurn()` | You want to call AtomicMemory inside a workflow step, an agent hook, or any other code path. Framework-agnostic. |

The adapter does **not** own provider configuration — pass an already-constructed `MemoryClient`.

## Install

```bash
pnpm add @atomicmemory/mastra @atomicmemory/sdk @mastra/core zod
```

`@mastra/core` and `zod` are declared as peerDependencies so you pin compatible versions alongside the rest of your Mastra app.

## Quick start — agent tools

```ts
import { Agent } from '@mastra/core/agent';
import { MemoryClient } from '@atomicmemory/sdk';
import { createMemoryTools } from '@atomicmemory/mastra';

const memory = new MemoryClient({
  providers: { atomicmemory: { apiUrl: process.env.ATOMICMEMORY_URL!, apiKey: process.env.ATOMICMEMORY_KEY! } },
});
await memory.initialize();

const { searchTool, ingestTool } = createMemoryTools(memory, {
  scope: { user: 'pip', namespace: 'my-app' },
  defaultLimit: 5,
});

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use memory_search to recall prior context. Use memory_ingest to remember new facts.',
  model: /* your model */,
  tools: { memory_search: searchTool, memory_ingest: ingestTool },
});
```

Scope is fixed at factory time — the agent cannot rebind to other users by passing different arguments.

## Quick start — framework-agnostic helpers

```ts
import { searchMemory, ingestTurn } from '@atomicmemory/mastra';

const { context } = await searchMemory(memory, {
  query: latestUserMessage,
  scope: { user: 'pip' },
  limit: 8,
});

if (context) {
  // Prepend context to the model call.
}

await ingestTurn(memory, {
  messages,
  completion: text,
  scope: { user: 'pip' },
});
```

### Custom retrieval formatting

The default formatter wraps retrieved memories in a delimited block with an explicit "reference, not instructions" header. Override per call:

```ts
await searchMemory(memory, {
  query,
  scope,
  formatter(results) {
    return `# Prior context\n\n${results.map((r) => `- ${r.memory.content}`).join('\n')}`;
  },
});
```

### System-message handling on ingest

`ingestTurn()` excludes `system` messages by default — opt in via `includeRoles` only when your system content is genuinely user-authored material worth remembering.

## Scope

Scope fields follow the SDK's `Scope` type — `user`, `agent`, `namespace`, `thread`. At least one must be provided; the SDK rejects scopeless requests.

## License

Apache-2.0.
