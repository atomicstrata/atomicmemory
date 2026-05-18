# @atomicmemory/vercel-ai

AtomicMemory adapter for the [Vercel AI SDK](https://sdk.vercel.ai/docs). Composable primitives for giving any message-driven model call durable, semantic memory.

## Primitives

| API | Use when |
|---|---|
| `retrieve()` | Tool-call / multimodal flows. Returns just the rendered system message (or `null`). You inject it into your original message array yourself. |
| `augmentWithMemory()` | Text-only flows. Convenience wrapper that prepends the system message to your `Message[]`. |
| `ingestTurn()` | After any model call — persists the turn (system messages excluded by default). |
| `withMemory()` | Text-only flows — one-call wrapper around `augmentWithMemory` + your model call + `ingestTurn`. |
| `fromModelMessage()` / `fromModelMessages()` | Bridge AI SDK v5 `ModelMessage` content-part arrays into the SDK's text-only `Message` shape. Lossy by design — see below. |

The adapter intentionally does **not** import from `ai` — it operates on the SDK's `Message` type (`content: string`) and delegates the model call to the caller. That keeps it insulated from `ai` version churn.

## Status: pre-publish local development

This package is intended to publish as `@atomicmemory/vercel-ai`. Until
`@atomicmemory/sdk` is published and pinned to a registry version, it depends
on the SDK through the monorepo's workspace `file:` spec. See the
[mcp-server status note](../../packages/mcp-server/README.md) for the
clone-and-build flow.

## Scope: text content only

The SDK stores memory as text (`Message.content: string`). The adapter's `Message[]`-in / `Message[]`-out surface is compatible with AI SDK text-only flows. It is **not** compatible with AI SDK v5's `ToolModelMessage` (whose `content` must stay as `ToolResultPart[]` when fed back into `streamText` / `generateText`).

For tool-call or multimodal conversations, use `retrieve()` + `ingestTurn()` directly:

1. Flatten your `ModelMessage[]` through `fromModelMessages()` for memory search / ingest queries.
2. Call `retrieve()` with the flattened messages to get just a system message.
3. Insert that system message (or its content) into your **original** `ModelMessage[]`.
4. Run your model call.
5. Call `ingestTurn()` with the flattened messages and the completion text.

The flattened `Message[]` is memory-only — do not feed it back into AI SDK model calls once tool messages enter the transcript.

## Usage

### Text-only flow — one call

```ts
import { streamText } from 'ai';
import { withMemory } from '@atomicmemory/vercel-ai';
import { MemoryClient } from '@atomicmemory/sdk';

const memory = new MemoryClient({
  providers: { atomicmemory: { apiUrl: process.env.ATOMICMEMORY_URL!, apiKey: process.env.ATOMICMEMORY_KEY! } },
});
await memory.initialize();

const result = await withMemory({
  client: memory,
  scope: { user: 'pip', namespace: 'my-app' },
  messages,
  async run(augmented) {
    const response = streamText({ model, messages: augmented });
    return { text: await response.text };
  },
});
```

### Tool-call / multimodal flow

```ts
import { generateText, type ModelMessage } from 'ai';
import {
  fromModelMessages,
  retrieve,
  ingestTurn,
} from '@atomicmemory/vercel-ai';

const modelMessages: ModelMessage[] = [/* your real conversation */];
const flat = fromModelMessages(modelMessages);
const scope = { user: 'pip' };

const { systemMessage, retrieved } = await retrieve(memory, {
  messages: flat,
  scope,
});

const { text } = await generateText({
  model,
  messages: systemMessage
    ? [
        // AI SDK v5: string-content system message is valid
        { role: 'system', content: systemMessage.content },
        ...modelMessages,
      ]
    : modelMessages,
});

await ingestTurn(memory, {
  messages: flat,
  completion: text,
  scope,
});
```

### Primitives for text-only flows (split)

```ts
import { augmentWithMemory, ingestTurn } from '@atomicmemory/vercel-ai';

const { messages: augmented, retrieved } = await augmentWithMemory(memory, {
  messages,
  scope,
  limit: 10,
});

const response = streamText({ model, messages: augmented });
const text = await response.text;

await ingestTurn(memory, { messages, completion: text, scope });
```

### Custom retrieval formatting

The default formatter wraps retrieved memories in a delimited block with an explicit "reference, not instructions" header. This is a mitigation against instruction-shaped content hijacking the model — not a guarantee. Callers storing higher-risk content should add sanitization.

```ts
const { systemMessage } = await retrieve(memory, {
  query: 'what do I know about X?',
  scope,
  formatter(results) {
    return `# Relevant prior context\n\n${results
      .map((r) => `- [${r.memory.createdAt.toISOString()}] ${r.memory.content}`)
      .join('\n')}`;
  },
});
```

### System-message handling on ingest

`ingestTurn()` **excludes `system` messages by default** — applications typically use them for hidden instructions and policies that should never become durable memory. If your system messages are genuinely user-authored content worth remembering, opt in:

```ts
await ingestTurn(memory, {
  messages,
  completion: text,
  scope,
  includeRoles: ['system', 'user', 'assistant', 'tool'],
});
```

## Scope

Scope fields follow the SDK's `Scope` type: `user | agent | namespace | thread`. At least one must be provided — the SDK rejects scopeless requests.

## License

Apache-2.0.
