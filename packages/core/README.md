# Atomicmemory Core

[![CI](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml/badge.svg)](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40atomicmemory%2Fcore?label=npm)](https://www.npmjs.com/package/@atomicmemory/core)
[![Docker](https://img.shields.io/badge/docker-GHCR-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Docs](https://img.shields.io/badge/docs-docs.atomicstrata.ai-blue)](https://docs.atomicstrata.ai)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Open-source memory engine for AI applications and agents.

Docker-deployable memory backend with durable context, semantic retrieval, and memory mutation (AUDN-SC: Add, Update, Delete, No-op + Supersede, Clarify). Pre-AUDN rejections use a separate `SKIP` ingest trace sentinel.

**Docs:** [docs.atomicstrata.ai](https://docs.atomicstrata.ai)

## Features

- **Semantic ingest** — extract structured facts from conversations with contradiction detection
- **Hybrid retrieval** — vector similarity + BM25/FTS with RRF fusion
- **AUDN-SC mutation** — Add, Update, Delete, No-op, Supersede, and Clarify decisions with fail-closed integrity
- **Claim versioning** — temporal lineage tracking with supersession and invalidation
- **Tiered context packaging** — L0/L1/L2 compression for token-efficient retrieval
- **Entity graph** — spreading activation over extracted entities
- **Pluggable embeddings** — openai, openai-compatible, ollama, transformers (local WASM)
- **Docker-deployable** — one-command deployment with Postgres + pgvector

## Headline Results

AtomicMemory v66 is cost-Pareto SOTA on BEAM-100K, BEAM-1M, and LoCoMo10 under matched methodology against published competitors. On BEAM-10M it matches the strongest published Mem0-new result while leaving Hindsight-scale temporal retrieval as the known open frontier.

| Benchmark | AtomicMemory v66 | Position | Cost/Q | Sample |
|---|---:|---|---:|---:|
| **BEAM-100K lenient** | **0.7375** | Parity with Hindsight at 0.75 | $1.26 | n=80 |
| **BEAM-1M lenient** | **0.6625** | Cost-Pareto SOTA; +0.022 vs Mem0 paper | $0.083 | n=80 |
| **BEAM-10M lenient** | **0.4875** | Parity with Mem0-new at 0.486 | $0.081 | n=80 |
| **LoCoMo10 GPT-4o-mini binary** | **0.8396** | Cost-Pareto SOTA; +0.171 vs Mem0 paper | $0.066 | n=1540 |

These results put AtomicMemory at or near the published ceiling in each reported category while preserving the lower-cost operating profile that matters for real applications. Reproducibility artifacts and harness details will be published with the benchmark materials.

## What This Is Not

- Not a benchmark suite — eval harnesses live in a separate research repo
- Not an SDK or client library — this is the server/backend. For a TypeScript
  client, see [@atomicmemory/sdk](../sdk)

## Quick Start

For the full walkthrough, see the [Core Quickstart](https://docs.atomicstrata.ai/quickstart).

### Docker image (recommended)

After the first tagged release, you can run Core from the published GHCR image
without cloning the repository. By default, the image starts an embedded
Postgres/pgvector database and persists it to the mounted host directory:

```bash
export OPENAI_API_KEY=sk-...

docker run --rm -it --pull always \
  -p 127.0.0.1:17350:17350 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -v $HOME/.atomicstrata/atomicmemory-docker:/var/lib/atomicmemory/postgres \
  ghcr.io/atomicstrata/atomicmemory-core:latest
```

The image is published as `ghcr.io/atomicstrata/atomicmemory-core` with
`latest`, semver, and commit-SHA tags.

The public monorepo's `Publish Core Docker Image` workflow runs after
`@atomicmemory/core` is published to npm and verified by the ops publishing
helper. It resolves the npm package version, skips if that version is already
present in GHCR, checks out the package `gitHead`, builds
`packages/core/Dockerfile`, smoke-tests the local image, and then pushes the
matching GHCR tags.

Local Docker defaults use `Authorization: Bearer local-dev-key`, OpenAI
embeddings at 1536 dimensions, and `RAW_STORAGE_DEPLOYMENT_ENV=local`. The
quickstart binds to `127.0.0.1` so that default key is only exposed locally.

For production deployments, set real secrets and `DATABASE_URL` to your managed
Postgres/pgvector connection string. When `DATABASE_URL` is unset or set to
`embedded`, the container starts the bundled local Postgres instance.

```bash
export CORE_API_KEY=$(openssl rand -hex 32)
export STORAGE_KEY_HMAC_SECRET=$(openssl rand -hex 32)

docker run --rm -it --pull always \
  -p 17350:17350 \
  -e DATABASE_URL=postgresql://user:pass@postgres.example.com:5432/atomicmemory \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e CORE_API_KEY=$CORE_API_KEY \
  -e STORAGE_KEY_HMAC_SECRET=$STORAGE_KEY_HMAC_SECRET \
  -e EMBEDDING_DIMENSIONS=1536 \
  -e RAW_STORAGE_DEPLOYMENT_ENV=production \
  ghcr.io/atomicstrata/atomicmemory-core:latest
```

If you prefer a two-container local stack, you can also run the app image with
the bundled compose file:

```bash
curl -fsSLO https://raw.githubusercontent.com/atomicstrata/atomicmemory/main/packages/core/docker-compose.image.yml
cat > .env <<'EOF'
OPENAI_API_KEY=sk-...
CORE_API_KEY=replace-with-a-strong-random-secret
STORAGE_KEY_HMAC_SECRET=000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
EMBEDDING_DIMENSIONS=1536
RAW_STORAGE_DEPLOYMENT_ENV=local
EOF
docker compose -f docker-compose.image.yml up
```

### Docker from source

```bash
git clone https://github.com/atomicstrata/atomicmemory.git
cd atomicmemory/packages/core
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and DATABASE_URL
docker compose up --build
```

### Local development

```bash
npm install
cp .env.example .env
# Edit .env — requires a running Postgres instance with pgvector
npm run migrate
npm run dev
```

Health check: `curl http://localhost:17350/v1/memories/health`

### Migrations

Core uses versioned migration files as the single source of truth for
PostgreSQL schema. The files live under `src/db/migrations/` and ship to the
package as `dist/db/migrations/`. There is no `schema.sql` — the migrations
folder is the schema, in order. To regenerate the equivalent full-schema dump
locally, replay the migrations against an empty DB and run
`pg_dump --schema-only`.

Run migrations once before deploy or during a single startup step before
serving traffic:

```bash
npm run migrate
```

Docker image users can keep the default startup migration step for local or
single-replica deployments. For rolling production deploys, run migrations as
a pre-deploy job and start app containers with
`ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP=false`. If startup migrations remain
enabled, `MIGRATION_LOCK_TIMEOUT_MS` raises the advisory-lock wait window.

Applications that embed Core can call the programmatic API directly instead
of shelling out:

```ts
import { migrate, migrationStatus } from '@atomicmemory/core';

const status = await migrationStatus({ pool });
if (status.status !== 'up_to_date') {
  await migrate({ pool });
}
```

The `migrate()` and `migrationStatus()` signatures are unchanged from Phase 1;
only their internals were rewritten on top of `node-pg-migrate`. `MigrateResult`
fields are populated the same way — `ranSchemaSql` now means "this call
executed the migration runner path" rather than "this call executed the legacy
`schema.sql` file".
`MigrationStatus` adds read-only diagnostics sourced from the framework and
pgvector catalogs: `appliedMigrationCount`, `latestMigrationName`,
`migrationHistoryStatus`, and `embeddingDimension`.

To inspect a running database, two tables answer different questions:

| Table            | Question it answers                                      |
|------------------|----------------------------------------------------------|
| `pgmigrations`   | Which migration files have been applied, and in what order |
| `schema_version` | Which `@atomicmemory/core` semver this DB corresponds to |

Both are kept on purpose. `pgmigrations` is the framework's audit trail;
`schema_version` is the operator-friendly "what code matches this DB" stamp.
Querying either is safe from any client.

```sql
SELECT id, name, run_on FROM pgmigrations ORDER BY id;
SELECT sdk_version, schema_sha256, applied_at FROM schema_version
 ORDER BY applied_at DESC LIMIT 1;
```

Upgrades are lossless. A v1.0.x or Phase-1 database with existing rows takes
the same `migrate()` call as a fresh install — `migrate()` detects the
pre-migration install state, stamps the baseline migration as already-applied
without re-executing it, and runs only the migrations after the baseline.
See [`docs/db/migrations.md`](docs/db/migrations.md) for the scenario-by-scenario
guarantees and inspection guide.

The provenance SQL files under `docs/db/changelog/` are references only;
runtime schema execution is owned entirely by the `src/db/migrations/` folder.

### npm CLI

The npm package also ships a thin CLI for environments where you already have
a Postgres database with pgvector:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/atomicmemory

npx -y @atomicmemory/core migrate --profile local
npx -y @atomicmemory/core start --profile local
```

The `local` profile fills local-only defaults for the port, bearer key,
storage policy, local transformers embeddings, and Claude Code as the LLM
provider. It does not create or manage Postgres; use the Docker image above
when you want the database bundled with Core.

## API Overview

### Core endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/memories/ingest` | Full ingest with extraction and AUDN-SC |
| `POST` | `/v1/memories/ingest/quick` | Fast ingest (embedding dedup only) |
| `POST` | `/v1/memories/search` | Semantic search with hybrid retrieval |
| `POST` | `/v1/memories/search/fast` | Fast vector-only search |
| `GET` | `/v1/memories/list` | List memories with optional filters |
| `GET` | `/v1/memories/:id` | Get a single memory |
| `DELETE` | `/v1/memories/:id` | Soft-delete a memory |
| `POST` | `/v1/memories/consolidate` | Consolidate and compress memories |

See the [HTTP API reference](https://docs.atomicstrata.ai/api-reference/http/conventions) for full endpoint documentation.

### Per-request config override

Search and ingest routes accept an optional `config_override` body field that
overlays the startup `RuntimeConfig` for that single request. Useful for
A/B tests, experiments, or dial-turning without restarting the server.

```bash
curl -X POST http://localhost:17350/v1/memories/search \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "alice",
    "query": "what stack does alice use?",
    "config_override": { "hybridSearchEnabled": true, "maxSearchResults": 20 }
  }'
```

Responses from requests carrying an override emit four observability headers:

| Header | Emitted when | Value |
|--------|--------------|-------|
| `X-Atomicmem-Config-Override-Applied` | Override present | `true` |
| `X-Atomicmem-Effective-Config-Hash` | Override present | `sha256:<hex>` of the merged config |
| `X-Atomicmem-Config-Override-Keys` | Override present | Comma-joined sorted override keys |
| `X-Atomicmem-Unknown-Override-Keys` | One or more keys don't match a current `RuntimeConfig` field | Comma-joined sorted unknown keys |

The schema is permissive — unknown keys don't 400. They ride through on the
effective config and surface via the fourth header plus a server-side warning
log, so callers catch typos without gating new runtime fields behind a schema
release.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string (must have pgvector extension) |
| `OPENAI_API_KEY` | OpenAI API key (when using `openai` embedding/LLM provider) |
| `PORT` | Server port (default: 17350) |

### Embedding Provider

Set `EMBEDDING_PROVIDER` to choose your embedding backend:

| Value | Description |
|-------|-------------|
| `openai` | OpenAI Embeddings API (default) |
| `openai-compatible` | Any OpenAI-compatible API (recommended for self-hosters) |
| `ollama` | Local Ollama instance |
| `transformers` | Local WASM/ONNX inference via @huggingface/transformers |
| `voyage` | Voyage AI embeddings with separate document/query models |

For self-hosted deployments, `openai-compatible` is recommended as it works with any OpenAI-compatible embedding service.

### LLM Provider

Set `LLM_PROVIDER` to choose the extraction backend:

| Value | Description |
|-------|-------------|
| `openai` | OpenAI Chat Completions API (default) |
| `openai-compatible` | Any OpenAI-compatible chat API |
| `ollama` | Local Ollama instance |
| `groq` | Groq OpenAI-compatible API |
| `anthropic` | Anthropic Messages API |
| `google-genai` | Google Gemini OpenAI-compatible endpoint |
| `claude-code` | Local Claude Code Agent SDK session for personal development |
| `codex` | Local Codex account session for personal development |

For personal local use, `LLM_PROVIDER=claude-code` and `LLM_PROVIDER=codex`
use the logged-in `claude` or `codex` account session instead of requiring a
separate LLM API key. `claude-code` routes through the Claude Agent SDK;
`codex` reads the auth file produced by `codex login` and calls the Codex
backend directly. They still consume the user's account limits and are not
intended for hosted or team deployments. Pair either one with a non-OpenAI
embedding provider, such as `EMBEDDING_PROVIDER=transformers`, if you want to
run without an OpenAI API key as well.

For AtomicMemory for Codex local setup, prefer `codex login` with
`LLM_PROVIDER=codex`. Use `LLM_PROVIDER=openai` plus `OPENAI_API_KEY` for
hosted or team deployments.

In-process benchmark harnesses can avoid editing env files by passing a
composition-time config to the runtime:

```ts
import { config, createCoreRuntime } from '@atomicmemory/core';

const runtime = createCoreRuntime({
  pool,
  config: {
    ...config,
    embeddingProvider: 'voyage',
    embeddingDimensions: 1024,
    voyageApiKey,
    voyageDocumentModel: 'voyage-4-large',
    voyageQueryModel: 'voyage-4-lite',
  },
});
```

Provider/model fields are still startup-only for a given runtime. Use a new
isolated runtime or process for each embedding configuration.

See `.env.example` for the full list of configuration options.

## Deployment

### Platform-specific deployment

See `deploy/` for platform-specific configs (Railway, etc.). Copy the relevant config to your project root before deploying.

### Docker

```bash
docker compose up --build
```

The compose file includes Postgres with pgvector. The app container runs migrations on startup, then starts the server.

## Architecture

```
src/
  routes/       # Express route handlers
  services/     # Business logic (extraction, retrieval, packaging)
  db/           # Repository layer and canonical schema
  adapters/     # Type contracts for external integrations
  config.ts     # Environment-driven configuration
  server.ts     # Express app bootstrap
```

Storage: Postgres + pgvector. Retrieval: hybrid (vector + BM25/FTS). Mutation: contradiction-safe AUDN-SC with claim versioning.

## Development

```bash
npm test                    # Run unit tests
npm run test:deployment     # Deployment config tests
npm run test:docker-smoke   # Docker smoke test
npm run test:schema         # Schema regression fuzzing (Schemathesis)
npm run migrate:test        # Run migrations against test DB
```

### Schema regression tests

Property-based fuzzing of `openapi.yaml` via Schemathesis runs on every
PR (`schema-fuzz` job in `.github/workflows/ci.yml`). Catches wire-shape
regressions where a route's response drifts from its declared schema.
See [`tests/schema/`](tests/schema/) for how to run locally and how to
read the report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and code style expectations.

## License

[Apache-2.0](LICENSE)
