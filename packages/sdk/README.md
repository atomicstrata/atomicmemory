# @atomicmemory/sdk

[![CI](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml/badge.svg)](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40atomicmemory%2Fsdk?label=npm)](https://www.npmjs.com/package/@atomicmemory/sdk)
[![Docs](https://img.shields.io/badge/docs-docs.atomicstrata.ai-blue)](https://docs.atomicstrata.ai)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Backend-agnostic memory-layer SDK — pluggable providers, local embeddings, storage adapters, semantic search.

**Docs:** [docs.atomicstrata.ai/sdk](https://docs.atomicstrata.ai/sdk)

AtomicMemory Core currently reaches leading performance/cost on BEAM-100K, BEAM-1M, and LoCoMo10, with BEAM-10M parity against the strongest published Mem0-new result. The SDK is the typed application surface for building on that memory layer.

## What this package provides

- **`AtomicMemoryClient`** — primary public surface. Aggregates the
  memory and storage namespaces:
  `client.memory.search(...)` and `client.storage.put(...)`.
- **Provider interface + registry** — implement `MemoryProvider` to plug in any backend.
- **`AtomicMemoryProvider`** — HTTP adapter for [@atomicmemory/core](../core).
- **`Mem0Provider`** — HTTP adapter for [Mem0](https://github.com/mem0ai/mem0) (OSS or hosted).
- **`StorageManager`** — KV / cache adapters under the `./kv-cache` subpath (IndexedDB, in-memory).
- **`EmbeddingGenerator`** — local embedding generation via [`transformers.js`](https://github.com/huggingface/transformers.js).
- **`SemanticSearch`** — cosine-similarity search primitives.
- Error types (`AtomicMemoryError`, `StorageError`, `SearchError`,
  plus storage typed errors like `ArtifactInUseError`,
  `PointerContentNotManagedError`) and a minimal event emitter.

> **Server-side only in v1.** The direct storage API uses a shared
> bearer credential and must run inside a trusted process (a Node
> server, ops tooling, or the webapp-sdk proxy). Browser bundles
> must NOT instantiate `AtomicMemoryClient` directly.

## Installation

```bash
pnpm add @atomicmemory/sdk
```

Also works with `npm install` / `yarn add`.

## Quick start

For memory operations on a Node server, set `ATOMICMEMORY_API_KEY` in your
environment. No URL or provider configuration is needed for AtomicMemory Cloud.

```ts
import { MemoryClient } from '@atomicmemory/sdk';

const client = new MemoryClient();
await client.initialize();

await client.ingest({
  mode: 'text',
  content: 'I prefer aisle seats.',
  scope: { user: 'demo-user' },
});
const results = await client.search({
  query: 'seat preference',
  scope: { user: 'demo-user' },
});
```

Call `await client.initialize()` before any memory operation. The default provider
uses `https://api.atomicstrata.ai` and reads `ATOMICMEMORY_API_KEY` at initialization
in Node server contexts. A missing or blank Cloud key fails initialization before
any request. Cloud also rejects the local Core development key. Use a Cloud project
key or configure `providers.atomicmemory.apiUrl` for local Core.
The application sets `scope.user` explicitly. The API key does not select a memory user.

Explicit provider configuration takes precedence. An omitted AtomicMemory URL
still selects Cloud, and an explicit `apiKey` overrides the environment key.
The environment key also works with explicit dev and staging Cloud URLs,
`https://api.dev.atomicstrata.ai` and `https://api.staging.atomicstrata.ai`.
Cloud URLs must use HTTPS. Local or custom URLs, other providers, nondefault Cloud
ports, and URLs with embedded credentials never inherit the environment key.
Local endpoints can remain unauthenticated. An explicit `defaultProvider` must
name a provider in the configuration.

Browser callers use `@atomicmemory/sdk/browser` and configure credentials explicitly.
Do not put a server API key in browser code. Use only credentials safe for that
browser session, or send requests through your authenticated server instead.

### Memory and storage

Use `AtomicMemoryClient` when you also need storage. Its configuration is unchanged.
Start a local `atomicmemory-core` for the following example. The full SDK walkthrough
is in the [SDK Quickstart](https://docs.atomicstrata.ai/sdk/quickstart).

```ts
import { AtomicMemoryClient } from '@atomicmemory/sdk';

const client = new AtomicMemoryClient({
  apiUrl: 'http://localhost:17350',
  apiKey: process.env.ATOMICMEMORY_API_KEY!,
  userId: 'demo-user',
  memory: {
    providers: {
      atomicmemory: { apiUrl: 'http://localhost:17350' },
    },
  },
});
await client.memory.initialize();

// Memory namespace.
await client.memory.ingest({
  mode: 'messages',
  messages: [{ role: 'user', content: 'I prefer aisle seats.' }],
  scope: { user: 'demo-user' },
});
const results = await client.memory.search({
  query: 'seat preference',
  scope: { user: 'demo-user' },
});

// Storage namespace.
const artifact = await client.storage.put({
  mode: 'pointer',
  uri: 'https://example.com/file.pdf',
  contentType: 'application/pdf',
});
console.log(artifact.artifactId);
```

Applications that only need memory operations can use `MemoryClient` directly.

## Providers

### AtomicMemory (recommended for self-hosted)

```ts
const memory = new MemoryClient({
  providers: {
    atomicmemory: {
      apiUrl: 'http://localhost:17350',
      apiKey: process.env.ATOMICMEMORY_API_KEY,
      timeout: 30_000,
    },
  },
});
```

### Mem0

```ts
const memory = new MemoryClient({
  providers: {
    mem0: {
      apiUrl: 'http://localhost:8888',
      apiStyle: 'oss',
    },
  },
});
```

## Subpath exports

- `@atomicmemory/sdk/browser` — browser-safe entry: `MemoryClient` + memory types/adapters, without the root bundle's storage/embedding/search surface
- `@atomicmemory/sdk/storage` — storage artifact client + types (`ConcreteStorageClient`, `StorageClient`, `StoredArtifact`, error classes)
- `@atomicmemory/sdk/kv-cache` — KV / cache adapters (IndexedDB, in-memory) used internally by the embedding cache
- `@atomicmemory/sdk/embedding` — embedding generator
- `@atomicmemory/sdk/search` — semantic search primitives
- `@atomicmemory/sdk/utils` — shared utilities
- `@atomicmemory/sdk/core` — error types + events
- `@atomicmemory/sdk/memory` — memory types, provider interface, provider adapters

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

### Refreshing mapper test fixtures

The `AtomicMemoryProvider` mappers are guarded by a record/replay
test suite that runs against captured `atomicmemory-core` HTTP
responses. When core's wire shape changes, refresh the fixtures:

```bash
# In packages/core: ensure .env has a real
# OPENAI_API_KEY (or LLM_PROVIDER=ollama), then:
docker compose up -d --build

# Back in packages/sdk:
pnpm fixtures:capture
```

See [`src/memory/atomicmemory-provider/__tests__/fixtures/README.md`](./src/memory/atomicmemory-provider/__tests__/fixtures/README.md) for the full procedure and what gets normalized at capture time.

## Contributing

Issues and PRs welcome.

## License

Apache-2.0 © AtomicMemory
