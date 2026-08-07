# @atomicmemory/mcp-server

MCP server that exposes [AtomicMemory core](../../packages/core) as four tools to any MCP-compatible agent:

- `memory_search` — semantic retrieval
- `memory_ingest` — AUDN-SC-mutating ingest (`text` / `messages`) or deterministic one-record ingest (`verbatim`, provider permitting)
- `memory_package` — token-budgeted context package
- `memory_list` — list recent scoped memories

## Authoritative contract

The REST API and the [`@atomicmemory/sdk`](../../packages/sdk) type surface are
the authoritative memory contract — provenance, scope, mutation results,
retrieval scores, and context-package metadata are defined there. This MCP
server is a thin callable-tool adapter over that contract.

Tool results are returned as JSON-stringified text for host compatibility, so
the text payload is a transport convenience, not a separate audit surface. For
evidence or audit purposes, read the REST/SDK projection rather than parsing MCP
tool text. New memory semantics land in Core and the SDK first; this adapter
exposes them, it does not define them.

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
| `ATOMICMEMORY_API_URL` | no** | Provider base URL. Defaults to the local AtomicMemory core (`http://127.0.0.1:17350`) when `ATOMICMEMORY_PROVIDER=atomicmemory`; required for `mem0`. |
| `ATOMICMEMORY_API_KEY` | no | Bearer credential forwarded to providers that require HTTP authorization. Defaults to `local-dev-key` only for the local AtomicMemory core URL. |
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
- `mode: "verbatim"` with `content`: asks the provider to store exactly one deterministic record. This is intended for lifecycle records such as compact summaries. Providers that cannot guarantee verbatim semantics may reject it. Supply `contentClass` (`summary` | `redacted` | `raw`) describing what you are storing: a core with the default `RAW_CONTENT_POLICY=reject` refuses unstamped or `raw` verbatim content.

Optional `metadata`, `provenance`, and `kind` are accepted. Deterministic AtomicMemory records store the provided `content` directly; provenance is persisted through `sourceSite` / `sourceUrl`.

**Metadata guidance for agents:** `metadata` is only valid with `mode: "verbatim"` (Core rejects it on text/messages extraction). Use `provenance` (`source`, `sourceUrl`, `sourceId`) for tags and lineage. Safe integration keys in `metadata` are `externalId` and `dedupe_key` (the latter also synthesizes `sourceUrl` when omitted). Do **not** put core-internal keys in `metadata` — including `topic`, `headline`, `cmo_id`, `sourceSite`, and the full set in core's `RESERVED_METADATA_KEYS`. The MCP server rejects reserved keys and non-verbatim metadata before calling core.

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
