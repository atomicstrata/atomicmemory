# Changelog

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
