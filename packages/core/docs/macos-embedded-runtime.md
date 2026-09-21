# macOS embedded runtime contract

**Status:** Experimental — consumed by `am-app` DMG packaging (ADR 0002)  
**Engine PR:** [atomicstrata/atomicmemory-internal#81](https://github.com/atomicstrata/atomicmemory-internal/pull/81)  
**am-app spec:** [am-app embedded DMG spec](https://github.com/atomicstrata/am-app/blob/main/docs/superpowers/specs/2026-08-07-embedded-macos-dmg-runtime.md)

## Overview

The macOS DMG ships three runtime pieces under `AtomicMemory.app/Contents/Resources/Runtime/`:

| Artifact | Role |
|----------|------|
| `atomicmemory-core` | Deno-compiled lean Core API binary (~116 MB) |
| `postgres/` | Relocatable Postgres 17 + pgvector tree |
| `macos-embedded-entrypoint.sh` | Lifecycle script (initdb → migrate → start) |
| `lib/` | Sourced launcher helpers (Postgres + lifecycle) |

Data persists under `~/Library/Application Support/AtomicMemory/`. Node, Deno, and Docker are **not** required at runtime.

## Artifact names (CI / release)

| Name | Platform |
|------|----------|
| `atomicmemory-core-darwin-arm64` | macOS Apple Silicon |
| `atomicmemory-postgres-pgvector-darwin-arm64.tar.gz` | macOS Apple Silicon Postgres pack |

## Ports and binding

| Service | Default | Binding |
|---------|---------|---------|
| Core HTTP | `17350` | `127.0.0.1` only |
| Embedded Postgres | `54329` | `127.0.0.1` only (avoids clash with local 5432/5433) |

## Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `RUNTIME_ROOT` | No | Entrypoint script directory | Bundle `Resources/Runtime` |
| `STATE_ROOT` | No | `~/Library/Application Support/AtomicMemory` | Data + logs |
| `DATABASE_URL` | No | `embedded` | Use `embedded` or external `postgresql://...` |
| `CORE_API_KEY` | No | Generated + persisted | Also readable from Keychain by app supervisor |
| `STORAGE_KEY_HMAC_SECRET` | No | Local dev default | Set explicitly for production-like installs |
| `RAW_STORAGE_DEPLOYMENT_ENV` | No | `local` | |
| `EMBEDDING_PROVIDER` | No | `openai` | Lean profile |
| `EMBEDDING_DIMENSIONS` | No | `1536` | |
| `OPENAI_API_KEY` | **Yes** (lean) | — | Remote embeddings required in lean binary |
| `EMBEDDED_POSTGRES_PORT` | No | `54329` | |
| `EMBEDDED_POSTGRES_USER` | No | `atomicmemory` | |
| `EMBEDDED_POSTGRES_DB` | No | `atomicmemory` | |
| `PORT` | No | `17350` | Core listen port |
| `LISTEN_HOST` | No | `127.0.0.1` (launcher) | Core bind address; hosted/Docker leave unset |

## Directory layout

```text
Runtime/
  atomicmemory-core
  macos-embedded-entrypoint.sh
  lib/   macos-embedded-postgres.sh  macos-embedded-lifecycle.sh
  postgres/
    bin/   postgres pg_ctl initdb psql …
    lib/
    share/

~/Library/Application Support/AtomicMemory/
  postgres/          # PG data (PG_VERSION, …)
  postgres-run/      # Unix socket directory
  state/             # core-api-key, postgres-password, runtime.pid
  logs/              # postgres.log, core.log
```

## Lifecycle

```bash
export RUNTIME_ROOT=/path/to/Runtime
export STATE_ROOT="$HOME/Library/Application Support/AtomicMemory"
export OPENAI_API_KEY=sk-...
"$RUNTIME_ROOT/macos-embedded-entrypoint.sh" start
```

1. Validate runtime layout (Core binary + Postgres bin + `lib/`)
2. Resolve/generate `CORE_API_KEY`, Postgres SCRAM password, and local secrets
3. If `DATABASE_URL=embedded`: `initdb` (empty/valid cluster only) → conf-file `pg_ctl start` → `CREATE EXTENSION vector`
4. `atomicmemory-core migrate`
5. `atomicmemory-core start` bound to `LISTEN_HOST` (foreground; supervisor may wrap this)
6. On EXIT / SIGTERM / SIGINT: stop Core, then Postgres
7. `stop` signals the owning launcher/Core from `state/runtime.pid` after identity checks

Fail closed: any step failure exits non-zero. A nonempty data directory without `PG_VERSION` is not deleted.

## Lean profile limitations

Same as [deno-compile-spike.md](./deno-compile-spike.md):

- No local `@huggingface/transformers`
- No Filecoin / viem stack
- Remote OpenAI-compatible embeddings required

## License / redistribution

Shipping Postgres and pgvector inside a DMG requires compliance with their respective licenses (PostgreSQL License, pgvector license). Document attribution in the app About / legal notices. Do not redistribute Homebrew-built binaries in production DMGs without a dedicated relocatable build — use `scripts/package-darwin-pgvector.sh` output.

## Related docs

- [deno-compile-spike.md](./deno-compile-spike.md) — Deno lean binary
- [darwin-pgvector-pack.md](./darwin-pgvector-pack.md) — Postgres pack build
