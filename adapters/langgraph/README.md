# @atomicmemory/langgraph

AtomicMemory adapter for [LangGraph JS](https://langchain-ai.github.io/langgraphjs/). Node factories and framework-agnostic helpers around an injected `MemoryClient` from `@atomicmemory/sdk`.

| Surface | Use when |
|---|---|
| `createMemoryRetrieveNode()` | You want a graph node that searches AtomicMemory and merges the rendered context into state. |
| `createMemoryIngestNode()` | You want a graph node that persists the completed turn after the model call. |
| `searchMemory()` / `ingestTurn()` | You want to call AtomicMemory directly inside a node body, an edge condition, or another helper. |

The adapter does **not** import `@langchain/langgraph` at runtime — the node factories emit plain async `(state) => Partial<state>` functions you register with `.addNode()`. The peer declaration documents the intended consumer; pin the framework version in your application.

If you also want agent-callable tools (`memory_search`, `memory_ingest`), use [`@atomicmemory/langchain`](../langchain-js/README.md) — LangGraph consumes the same `tool()`-shaped objects.

## Install

```bash
pnpm add @atomicmemory/langgraph @atomicmemory/sdk @langchain/langgraph
```

## Minimal end-to-end example

```ts
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph';
import { MemoryClient } from '@atomicmemory/sdk';
import {
  createMemoryRetrieveNode,
  createMemoryIngestNode,
} from '@atomicmemory/langgraph';

const memory = new MemoryClient({
  providers: { atomicmemory: { apiUrl: process.env.ATOMICMEMORY_URL!, apiKey: process.env.ATOMICMEMORY_KEY! } },
});
await memory.initialize();

const scope = { user: 'pip', namespace: 'my-graph' };

const retrieve = createMemoryRetrieveNode<typeof MessagesAnnotation.State, { context: string | null }>(memory, {
  scope,
  getQuery: (state) => {
    const last = [...state.messages].reverse().find((m) => m.getType?.() === 'human');
    return typeof last?.content === 'string' ? last.content : '';
  },
  applyContext: (_state, context) => ({ context }),
});

const ingest = createMemoryIngestNode<typeof MessagesAnnotation.State, Record<string, never>>(memory, {
  scope,
  getMessages: (state) => state.messages.map((m) => ({
    role: m.getType?.() === 'human' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : '',
  })),
  getCompletion: (state) => {
    const last = state.messages.at(-1);
    return typeof last?.content === 'string' ? last.content : '';
  },
});

const graph = new StateGraph(MessagesAnnotation)
  .addNode('retrieve', retrieve)
  .addNode('model', async () => ({ /* your model call */ }))
  .addNode('ingest', ingest)
  .addEdge('__start__', 'retrieve')
  .addEdge('retrieve', 'model')
  .addEdge('model', 'ingest')
  .compile();
```

The `getQuery` / `applyContext` / `getMessages` / `getCompletion` extractors keep the adapter completely decoupled from any specific state schema. Use whatever channels your graph already exposes.

## Scope binding

Scope is fixed at factory time — agents and downstream nodes cannot rebind to other users by mutating state.

## Framework-agnostic helpers

```ts
import { searchMemory, ingestTurn } from '@atomicmemory/langgraph';

const { context } = await searchMemory(memory, { query, scope });
await ingestTurn(memory, { messages, completion: text, scope });
```

`ingestTurn()` excludes `system` messages by default — opt in via `includeRoles` only when your system content is genuinely user-authored material worth remembering.

## License

Apache-2.0.
