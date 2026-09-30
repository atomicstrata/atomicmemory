# @atomicmemory/mcp-server

MCP server that exposes [AtomicMemory core](../../packages/core) as six tools to any MCP-compatible agent:

- `memory_search` — semantic retrieval
- `memory_ingest` — AUDN-SC-mutating ingest (`text` / `messages`) or deterministic one-record ingest (`verbatim`, provider permitting)
- `memory_package` — token-budgeted context package
- `memory_list` — list recent scoped memories
- `entity_profile` — synthesized profile for a user or agent
- `entity_attributes` — structured (entity, attribute, value) triples

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
ATOMICMEMORY_API_KEY="<project-api-key>" npx -y @atomicmemory/mcp-server
```

With only a project API key set, stdio defaults to AtomicMemory Cloud. With
neither URL nor key set, stdio falls back to local Core at
`http://127.0.0.1:17350` (and synthesizes `local-dev-key`).

For source development, build the package locally with
`pnpm --filter @atomicmemory/mcp-server build` and run
`node packages/mcp-server/dist/bin.js`.

## Usage

You usually don't run this directly — coding-agent integrations such as Claude
Code, OpenClaw, Codex, and Cursor spawn it for you. If you want to wire it into
a custom MCP host directly:

```bash
# Cloud (key selects the Cloud default URL):
ATOMICMEMORY_API_KEY="<project-api-key>" npx -y @atomicmemory/mcp-server

# Local Core (no URL or key required):
npx -y @atomicmemory/mcp-server
```

## Config

The binary loads config from environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `ATOMICMEMORY_API_URL` | no (stdio)** / **yes (http)** | Provider base URL. Stdio: when unset, Cloud if `ATOMICMEMORY_API_KEY` is set, otherwise local Core (`http://127.0.0.1:17350`). Required for `mem0` and for HTTP mode. |
| `ATOMICMEMORY_API_KEY` | yes* | Bearer credential for **stdio / local** mode. Required for AtomicMemory Cloud; defaults to `local-dev-key` for the local Core loopback URL. **Not** used as a shared tenant key in HTTP hosted mode. |
| `ATOMICMEMORY_PROVIDER` | no | Provider name — one of `atomicmemory` or `mem0`. Defaults to `atomicmemory`. |
| `ATOMICMEMORY_SCOPE_USER` | no | Default `user` scope. In stdio mode it defaults to the local machine user when omitted. Hosted HTTP accepts it from the call or this env var — **do not set it on multi-tenant deployments** (callers should pass `scope.user`). |
| `ATOMICMEMORY_SCOPE_AGENT` | no* | Default `agent` scope |
| `ATOMICMEMORY_SCOPE_NAMESPACE` | no* | Default `namespace` scope |
| `ATOMICMEMORY_SCOPE_THREAD` | no* | Default `thread` scope |
| `ATOMICMEMORY_MCP_TRANSPORT` | no | `stdio` (default) or `http` for hosted Streamable HTTP. |
| `ATOMICMEMORY_MCP_PORT` | no | HTTP listen port (default **3100**). |
| `ATOMICMEMORY_MCP_HOST` | no | HTTP bind address (default `0.0.0.0`). |
| `ATOMICMEMORY_MCP_ENABLE_SSE` | no | Serve legacy SSE (`/sse`, `/messages`); default `true`. |
| `ATOMICMEMORY_MCP_ALLOWED_HOSTS` | no | Comma-separated Host header allowlist (hostnames without ports, IPv6 in brackets) for DNS-rebinding protection on `/mcp`, `/sse` and `/messages`. Requests with any other Host get **403**; `/healthz` is exempt so load balancer checks keep working. Unset keeps the SDK default (validation only when bound to loopback). |
| `ATOMICMEMORY_MCP_SESSION_IDLE_TTL_MS` | no | Close MCP sessions idle this long (default `1800000`, 30 min). |
| `ATOMICMEMORY_MCP_MAX_SESSIONS` | no | Process-wide cap on open sessions (default `1000`); new sessions beyond it get **429**. |
| `ATOMICMEMORY_MCP_MAX_SESSIONS_PER_KEY` | no | Per project API key cap on open sessions (default `50`); **429** beyond it. |
| `ATOMICMEMORY_MCP_AUTH_TIMEOUT_MS` | no | Timeout for the Cloud key-validation probe (default `5000`). |
| `ATOMICMEMORY_MCP_AUTH_CACHE_TTL_MS` | no | Reuse a successful key validation for this long (default `60000`; `0` disables). Failures are never cached. |

\* Scope fields mirror the SDK's `Scope` type (`user | agent | namespace | thread`). The API key is required for the Cloud stdio/embedded path, but hosted HTTP authenticates each request instead.

\** `mem0` remains configurable, but it is no longer assumed to live at the local AtomicMemory core URL. Set `ATOMICMEMORY_API_URL` explicitly when using `provider=mem0`. HTTP mode also requires an explicit URL (it does not apply the stdio three-step default).

## Transports

### Stdio (default)

Stdio resolves the provider URL in three steps: explicit `ATOMICMEMORY_API_URL`,
else Cloud when `ATOMICMEMORY_API_KEY` is set, else local Core
(`http://127.0.0.1:17350`):

```bash
# Cloud:
ATOMICMEMORY_API_KEY="<project-api-key>" npx -y @atomicmemory/mcp-server
# equivalent:
ATOMICMEMORY_API_KEY="<project-api-key>" npx -y @atomicmemory/mcp-server --stdio

# Local Core:
npx -y @atomicmemory/mcp-server --stdio
```

### HTTP (self-hosted)

Self-host Streamable HTTP with a project API key per request. **No OAuth.**
`ATOMICMEMORY_API_URL` is required (HTTP does not apply the stdio three-step
default). Stdio stays available as the local transport and resolves URL as
explicit URL, else Cloud when a key is set, else local Core.

```bash
ATOMICMEMORY_MCP_TRANSPORT=http \
ATOMICMEMORY_API_URL=https://api.atomicstrata.ai \
npx -y @atomicmemory/mcp-server --http
```

| Path | Purpose |
|---|---|
| `GET /healthz` (alias `/health`) | Deploy probe → `{"ok":true}` (**no auth**) |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP |
| `GET /sse` + `POST /messages` | Legacy SSE (when enabled) |

**Auth (HTTP only):** every MCP request must send `Authorization: Bearer <project API key>`. Missing or invalid keys return **401**. The key is bound per session and forwarded to Cloud REST; hosted mode does **not** use a shared server-side `ATOMICMEMORY_API_KEY` for all tenants.

The server validates each key with an authenticated Cloud probe and only a 2xx
counts as valid. If Cloud cannot confirm the key (non-2xx other than 401/403,
network error or timeout) the request gets **503** `auth_unavailable` and no
session is opened. A request that names an unknown or expired
`Mcp-Session-Id` gets **404** (JSON-RPC `-32001`) so the client re-initializes.
Do not set `ATOMICMEMORY_SCOPE_USER` on multi-tenant deployments; callers
should pass `scope.user` on each tool call.

Self-hosting the HTTP transport: see [HOSTED.md](./HOSTED.md).

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
  apiKey: process.env.ATOMICMEMORY_API_KEY,
  scope: { user: 'pip' },
});
```

Caller owns the transport.

## License

Apache-2.0.
