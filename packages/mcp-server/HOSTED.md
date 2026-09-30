# Self-hosting the MCP HTTP transport

Run `@atomicmemory/mcp-server` as a Streamable HTTP server in front of
AtomicMemory Cloud (or another compatible REST base). Clients authenticate with
a project API key on every request. There is no OAuth.

Stdio remains the local agent/plugin transport. It resolves the provider URL as
explicit `ATOMICMEMORY_API_URL`, else Cloud when `ATOMICMEMORY_API_KEY` is set,
else local Core at `http://127.0.0.1:17350`.

## Quick start (Docker)

Build from the repository root (workspace-aware Dockerfile):

```bash
docker build -f packages/mcp-server/Dockerfile -t atomicmemory-mcp:local .
docker run --rm -p 3100:3100 \
  -e ATOMICMEMORY_API_URL=https://api.atomicstrata.ai \
  atomicmemory-mcp:local
```

`ATOMICMEMORY_API_URL` is **required** in HTTP mode. Do **not** pass a shared
`ATOMICMEMORY_API_KEY` into the container for multi-tenant hosting — clients
send `Authorization: Bearer <project API key>` per request.

Health check (no auth):

```bash
curl -sS http://127.0.0.1:3100/healthz
# → {"ok":true}
```

## Entrypoint

```bash
node dist/bin.js --http
# or
ATOMICMEMORY_MCP_TRANSPORT=http node dist/bin.js
```

Default listen: `0.0.0.0:3100`.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /healthz` (alias `/health`) | Deploy probe → `{"ok":true}` (**no auth**) |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP |
| `GET /sse` + `POST /messages` | Legacy SSE (enabled by default; set `ATOMICMEMORY_MCP_ENABLE_SSE=0` to disable) |

## Auth

- Every `/mcp`, `/sse`, and `/messages` request requires
  `Authorization: Bearer <project API key>`.
- Missing, malformed, or invalid key → **401** with `WWW-Authenticate: Bearer`.
- Key validity is established by an authenticated Cloud probe; only a 2xx
  counts. Any other upstream status, a network error, or a timeout returns
  **503** `auth_unavailable` without opening a session.
- Unknown or expired `Mcp-Session-Id` returns **404** (JSON-RPC `-32001`);
  clients re-initialize. Session caps return **429**.
- The Bearer key is bound per MCP session and forwarded to Cloud REST.

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `ATOMICMEMORY_MCP_TRANSPORT` | yes (HTTP) | Set to `http` (or pass `--http`) |
| `ATOMICMEMORY_API_URL` | **yes (HTTP)** | Cloud REST base URL (e.g. `https://api.atomicstrata.ai`) |
| `ATOMICMEMORY_MCP_PORT` | no | Default `3100` |
| `ATOMICMEMORY_MCP_HOST` | no | Default `0.0.0.0` |
| `ATOMICMEMORY_MCP_ENABLE_SSE` | no | Default `true`; set `0`/`false` to disable `/sse` |
| `ATOMICMEMORY_MCP_ALLOWED_HOSTS` | no | Comma-separated Host header allowlist for DNS-rebinding protection on `/mcp`, `/sse`, and `/messages`. Unset keeps the SDK default (validation only when bound to loopback). `/healthz` is exempt. |
| `ATOMICMEMORY_MCP_SESSION_IDLE_TTL_MS` | no | Idle session TTL (default `1800000`, 30 min) |
| `ATOMICMEMORY_MCP_MAX_SESSIONS` | no | Process-wide session cap (default `1000`); **429** beyond it |
| `ATOMICMEMORY_MCP_MAX_SESSIONS_PER_KEY` | no | Per project API key session cap (default `50`); **429** beyond it |
| `ATOMICMEMORY_MCP_AUTH_TIMEOUT_MS` | no | Cloud key-validation probe timeout (default `5000`) |
| `ATOMICMEMORY_MCP_AUTH_CACHE_TTL_MS` | no | Cache successful key validations (default `60000`; `0` disables). Failures are never cached. |
| `ATOMICMEMORY_PROVIDER` | no | Default `atomicmemory` |
| `ATOMICMEMORY_SCOPE_*` | no | Default scope when the client omits fields. See the multi-tenant warning below. |
| `ATOMICMEMORY_API_KEY` | **no (HTTP)** | Stdio/local only — not a shared hosted tenant key |

### Multi-tenant warning

Do **not** set `ATOMICMEMORY_SCOPE_USER` on a multi-tenant deployment. Hosted
HTTP accepts `scope.user` from the tool call **or** from that env default; if
you set the env var, every tenant call that omits `scope.user` silently shares
one user identity. Prefer requiring callers to pass `scope.user` on every tool
call (the server never invents a user from the container OS identity).

## Client config example

Point an MCP host at your self-hosted URL and send the project API key as a
Bearer token:

```json
{
  "mcpServers": {
    "atomicmemory": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer amc_YOUR_PROJECT_API_KEY"
      }
    }
  }
}
```

Exact field names vary by host; the required pieces are the MCP URL and the
`Authorization: Bearer …` header.

## Smoke

```bash
# Health (no auth)
curl -sS https://mcp.example.com/healthz
# → {"ok":true}

# Initialize (expect 200 + mcp-session-id)
curl -sS -D - -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

## Local stdio (not HTTP)

```bash
# Cloud (default as of 0.1.6)
ATOMICMEMORY_API_KEY="<project-api-key>" \
npx -y @atomicmemory/mcp-server

# Local Core
ATOMICMEMORY_API_URL=http://127.0.0.1:17350 \
ATOMICMEMORY_API_KEY=local-dev-key \
npx -y @atomicmemory/mcp-server
```
