# Darwin Postgres 17 + pgvector pack

Build a **relocatable** Postgres/pgvector tree for macOS DMG embedding. Matches Docker image `pgvector/pgvector:pg17` major version (PostgreSQL 17).

## Output

```text
dist-bin/atomicmemory-postgres-pgvector-darwin-arm64.tar.gz
  postgres/
    bin/
    lib/
    share/
```

Gitignored — never commit the tarball or `dist-bin/postgres/`.

## Prerequisites (build machine)

- macOS arm64 (Apple Silicon) for the default artifact name
- Xcode command line tools
- Optional dev path: Homebrew `postgresql@17` + `pgvector` for local assembly only

## Build

```bash
cd packages/core

# Option A: assemble from a prepared source tree (recommended for CI)
export POSTGRES_SOURCE_PREFIX=/path/to/relocateable/postgres
./scripts/package-darwin-pgvector.sh

# Option B: dev-only — copy from Homebrew prefix (NOT for redistribution)
export POSTGRES_SOURCE_PREFIX="$(brew --prefix postgresql@17)"
export PGVECTOR_LIB_DIR="$(brew --prefix pgvector)/lib"
./scripts/package-darwin-pgvector.sh
```

## Smoke test

```bash
tar -xzf dist-bin/atomicmemory-postgres-pgvector-darwin-arm64.tar.gz -C /tmp/am-pg-test
export PATH="/tmp/am-pg-test/postgres/bin:$PATH"
export DYLD_LIBRARY_PATH="/tmp/am-pg-test/postgres/lib"
printf 'smoke-password\n' > /tmp/am-pg-pw
initdb -D /tmp/am-pg-data --username=atomicmemory \
  --auth-local=scram-sha-256 --auth-host=scram-sha-256 --pwfile=/tmp/am-pg-pw
printf "\nlisten_addresses = '127.0.0.1'\nport = 54329\n" >> /tmp/am-pg-data/postgresql.conf
pg_ctl -D /tmp/am-pg-data -w start
PGPASSWORD=smoke-password psql -h 127.0.0.1 -p 54329 -U atomicmemory -d postgres -c "CREATE DATABASE atomicmemory"
PGPASSWORD=smoke-password psql -h 127.0.0.1 -p 54329 -U atomicmemory -d atomicmemory -c "CREATE EXTENSION vector"
pg_ctl -D /tmp/am-pg-data -w stop
```

## Version pins

| Component | Pin |
|-----------|-----|
| PostgreSQL | 17.x (match Docker `pgvector/pgvector:pg17`) |
| pgvector | Latest compatible with PG17 |

Record exact versions used in release notes when publishing DMG artifacts.

## Production note

Homebrew copies are for **local development smoke only**. Production DMG builds should use a CI-produced relocatable pack with `install_name_tool` adjustments for `@loader_path` — extend `package-darwin-pgvector.sh` as that pipeline matures.
