# @atomicmemory/langchain

AtomicMemory adapter for [LangChain JS](https://js.langchain.com/). Thin wrappers around an injected `MemoryClient` from `@atomicmemory/sdk`.

The adapter exposes two surfaces:

| Surface | Use when |
|---|---|
| Helpers — `searchMemory()` / `ingestTurn()` | You want to call AtomicMemory inside a LangChain callback, an LCEL `RunnableLambda`, or any other code path. Framework-agnostic. |
| `createMemoryTools()` | You want AtomicMemory as agent-callable tools (`memory_search`, `memory_ingest`) consumable by `createToolCallingAgent`, LangGraph's tool node, or any `@langchain/core/tools`-compatible runner. |

The adapter does **not** own provider configuration — pass an already-constructed `MemoryClient`.

## Install

```bash
pnpm add @atomicmemory/langchain @atomicmemory/sdk @langchain/core zod
```

`@langchain/core` and `zod` are declared as peerDependencies so you can pin them at the version your LangChain graph already uses.

## Quick start — agent tools

```ts
import { MemoryClient } from '@atomicmemory/sdk';
import { createMemoryTools } from '@atomicmemory/langchain';

const memory = new MemoryClient({
  providers: { atomicmemory: { apiUrl: process.env.ATOMICMEMORY_URL!, apiKey: process.env.ATOMICMEMORY_KEY! } },
});
await memory.initialize();

const { searchTool, ingestTool } = createMemoryTools(memory, {
  scope: { user: 'pip', namespace: 'my-app' },
  defaultLimit: 5,
});

// Hand the tools to any LangChain agent runner:
const tools = [searchTool, ingestTool /*, ...your other tools */];
```

Scope is fixed at factory time — the agent cannot rebind to other users by passing different arguments.

## Quick start — framework-agnostic helpers

```ts
import { searchMemory, ingestTurn } from '@atomicmemory/langchain';

const { context, results } = await searchMemory(memory, {
  query: latestUserMessage,
  scope: { user: 'pip' },
  limit: 8,
});

if (context) {
  // Prepend `context` to your prompt, attach as a system message, etc.
}

// After the model call:
await ingestTurn(memory, {
  messages: turn.messages,
  completion: turn.responseText,
  scope: { user: 'pip' },
});
```

### Custom formatter

The default formatter wraps retrieved memories in a delimited block with an explicit "reference, not instructions" header — a mitigation against instruction-shaped content hijacking the model, not a guarantee. Override per call:

```ts
await searchMemory(memory, {
  query,
  scope,
  formatter(results) {
    return `# Prior context\n\n${results
      .map((r) => `- [${r.memory.createdAt.toISOString()}] ${r.memory.content}`)
      .join('\n')}`;
  },
});
```

### System-message handling on ingest

`ingestTurn()` excludes `system` messages by default — applications typically use them for hidden instructions and policies that should never become durable memory. Opt in explicitly if your system messages are genuinely user-authored content worth remembering:

```ts
await ingestTurn(memory, {
  messages,
  completion,
  scope,
  includeRoles: ['system', 'user', 'assistant', 'tool'],
});
```

## Scope

Scope fields follow the SDK's `Scope` type — `user`, `agent`, `namespace`, `thread`. At least one must be provided; the SDK rejects scopeless requests.

## License

Apache-2.0.
