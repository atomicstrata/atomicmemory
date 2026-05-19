# @atomicmemory/mcp-server

MCP server that exposes [AtomicMemory core](../../packages/core) as four tools to any MCP-compatible agent:

- `memory_search` — semantic retrieval
- `memory_ingest` — AUDN-SC-mutating ingest (`text` / `messages`) or deterministic one-record ingest (`verbatim`, provider permitting)
- `memory_package` — token-budgeted context package
- `memory_list` — list recent scoped memories

## Status: package entrypoint

This package is intended to publish as `@atomicmemory/mcp-server`. Cursor and
other MCP-compatible hosts can launch it directly with `npx`:

```bash
npx -y @atomicmemory/mcp-server
```

For source development, build the package locally with
`pnpm --filter @atomicmemory/mcp-server build` and run
`node packages/mcp-server/dist/bin.js`.

## Usage

You usually don't run this directly — coding-agent integrations such as Claude
Code, OpenClaw, Codex, and Cursor spawn it for you. If you want to wire it into
a custom MCP host directly:

```bash
npx -y @atomicmemory/mcp-server
```

## Config

The binary loads config from environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `ATOMICMEMORY_API_URL` | no** | Provider base URL. Defaults to the local AtomicMemory core (`http://127.0.0.1:3050`) when `ATOMICMEMORY_PROVIDER=atomicmemory`; required for `mem0`. |
| `ATOMICMEMORY_API_KEY` | no | Optional bearer credential forwarded to providers that require HTTP authorization. |
| `ATOMICMEMORY_PROVIDER` | no | Provider name — one of `atomicmemory` or `mem0`. Defaults to `atomicmemory`. |
| `ATOMICMEMORY_SCOPE_USER` | no | Default `user` scope. Defaults to the local machine user when omitted. |
| `ATOMICMEMORY_SCOPE_AGENT` | no* | Default `agent` scope |
| `ATOMICMEMORY_SCOPE_NAMESPACE` | no* | Default `namespace` scope |
| `ATOMICMEMORY_SCOPE_THREAD` | no* | Default `thread` scope |

\* Scope fields mirror the SDK's `Scope` type (`user | agent | namespace | thread`).

\** `mem0` remains configurable, but it is no longer assumed to live at the local AtomicMemory core URL. Set `ATOMICMEMORY_API_URL` explicitly when using `provider=mem0`.

## Ingest modes

`memory_ingest` accepts:

- `mode: "text"` with `content`: runs the provider's extraction pipeline.
- `mode: "messages"` with `messages`: runs extraction over structured chat messages.
- `mode: "verbatim"` with `content`: asks the provider to store exactly one deterministic record. This is intended for lifecycle records such as compact summaries. Providers that cannot guarantee verbatim semantics may reject it.

Optional `metadata`, `provenance`, and `kind` are accepted. Deterministic AtomicMemory records store the provided `content` directly; provenance is persisted through `sourceSite` / `sourceUrl`. Caller-supplied `metadata` is forwarded to core's `/v1/memories/ingest/quick` route and persisted to the memory's `metadata` JSONB column (atomicmemory-core PR #51 + atomicmemory-sdk PR #15). It also continues to carry integration behavior such as `dedupe_key`, which the MCP layer reads to synthesize a deterministic `sourceUrl` when the caller omits `provenance.sourceUrl`. Reserved keys (`cmo_id`, `headline`, `memberMemoryIds`, etc. — full list in core's `RESERVED_METADATA_KEYS`) are rejected by core with 400.

## Embedding in a plugin runtime

OpenClaw and similar hosts can embed the server in-process via the `./spawn` subpath export:

```ts
import { spawnAtomicMemoryMcp } from '@atomicmemory/mcp-server/spawn';

const { server } = await spawnAtomicMemoryMcp({
  provider: 'atomicmemory',
  scope: { user: 'pip' },
});
```

Caller owns the transport.

## License

Apache-2.0.
