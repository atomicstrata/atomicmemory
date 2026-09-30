# Changelog

## Unreleased

## 0.1.6 - 2026-09-24

### Added

- Hosted Streamable HTTP transport (`--http` / `ATOMICMEMORY_MCP_TRANSPORT=http`)
  with `/healthz`, `/mcp`, and optional legacy SSE (`/sse`, `/messages`) for
  legacy SSE clients.
- Bearer project API-key auth on HTTP paths; per-session MemoryClient binding.
  Stdio remains the local transport and resolves URL as explicit
  `ATOMICMEMORY_API_URL`, else Cloud when `ATOMICMEMORY_API_KEY` is set, else
  local Core at `http://127.0.0.1:17350`.

### Security

- Hosted HTTP accepts a project key only on a 2xx from the Cloud key check;
  401/403 reject it, and any other status, network error, or timeout returns
  503 without opening a session. Positive results are cached briefly.
- Hosted HTTP no longer crashes when an SSE request carries a different key
  than the one that opened the session; it returns 401.
- Unknown session IDs return 404 (JSON-RPC -32001) so clients re-initialize
  after a restart.
- Global and per-key session caps (429) and idle-session eviction, configured
  through `ATOMICMEMORY_MCP_*` environment variables. Optional
  `ATOMICMEMORY_MCP_ALLOWED_HOSTS` enables Host header validation.
- Hosted tool calls must pass an explicit scope user; the container's OS user
  is never used as a shared default.

### Fixed

- Fail closed during configuration when AtomicMemory Cloud is selected without
  a project API key, including equivalent case and default-port URL spellings.
- Resolve the stdio/embedded default URL in three steps: explicit
  `ATOMICMEMORY_API_URL`, else Cloud when `ATOMICMEMORY_API_KEY` is set, else
  local Core at `http://127.0.0.1:17350`. Hosted HTTP still requires an
  explicit URL.
- Refuse the local Core key `local-dev-key` for Cloud origins so a local setup
  cannot send memory content to Cloud by accident.

## 0.1.5 - 2026-08-04

### Added

- Preflight reserved metadata keys on `memory_ingest` with agent-facing tool schema guidance.
- Drift test keeping MCP reserved keys aligned with core `RESERVED_METADATA_KEYS`.

## 0.1.4 - 2026-06-15

### Security

- Added opt-in `ATOMICMEMORY_SCOPE_LOCK` to harden scope handling for shared and
  multi-tenant deployments. Upgrade recommended.

## 0.1.1 - 2026-05-14

### Fixed

- Forward `ATOMICMEMORY_API_KEY` to the SDK provider so MCP clients can authenticate against protected AtomicMemory core deployments.

## 0.1.0 - 2026-05-14

### Added

- Initial public release of the AtomicMemory MCP server.
