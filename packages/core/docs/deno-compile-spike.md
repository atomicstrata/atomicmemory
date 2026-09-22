# Deno compile spike — Core API (external Postgres)

Experimental packaging path for compiling AtomicMemory Core into a single
executable. **Node + Docker remain the canonical distribution.** This spike
validates whether Deno `compile` can ship the API process against an external
Postgres/pgvector instance.

## Quick start

```bash
brew install deno
pnpm install --filter @atomicmemory/core
cd packages/core
./scripts/deno-compile-core.sh

docker compose up postgres -d
export DATABASE_URL='postgresql://atomicmemory:atomicmemory@localhost:5433/atomicmemory'
export RAW_STORAGE_DEPLOYMENT_ENV=local
export CORE_API_KEY='test-core-api-key'
export STORAGE_KEY_HMAC_SECRET='000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
export EMBEDDING_DIMENSIONS=1024
export EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY='sk-...'
./dist-bin/atomicmemory-core migrate
./dist-bin/atomicmemory-core start
curl http://localhost:17350/health
```

## Spike results (2026-07-31)

| Item | Result |
|------|--------|
| Deno version | 2.9.4 (Homebrew, macOS arm64) |
| Entry point | lean staging `dist/bin.js` (after `pnpm run build`) |
| Binary size | **~116 MB** (lean staging + `--node-modules-dir=manual`) |
| Cold start (`--help`) | ~24 ms |
| `migrate` | Pass |
| `start` + `GET /health` | Pass (HTTP 200) |
| `GET /openapi.json` | Pass |
| Runtime Deno required | No |

Environment profile: remote OpenAI embeddings (`EMBEDDING_PROVIDER=openai`),
non-Filecoin storage. Local `@huggingface/transformers` and Filecoin/viem are
**not** in the lean binary.

### Size progression

| Approach | Size | Notes |
|----------|------|-------|
| `--node-modules-dir=auto` (full monorepo) | ~774 MB | Works; embeds transformers, viem, Filecoin, vitest, typescript |
| `--bundle --exclude-unused-npm` | ~447 MB | Still pulls heavy reachable deps |
| `--bundle --minify` | ~441 MB | Negligible further gain |
| Lean staging (drop heavy deps) + manual | **~116 MB** | Current default in `deno-compile-core.sh` |

## Go / no-go

**Go for experimental local distribution** of the Core API process when:

- Postgres/pgvector is external.
- Remote embedding/LLM providers are configured (OpenAI-compatible).
- Filecoin / local transformers are not required.
- ~116 MB binary size is acceptable.

**No-go for replacing Docker/npm today** because:

- Lean profile intentionally omits Filecoin + local transformers.
- No CI artifact or release channel yet.
- Node + Docker remain the supported paths.

## Compile strategy (current)

`scripts/deno-compile-core.sh`:

1. `pnpm run build` → `dist/`
2. Stage a lean `package.json` without:
   - `@huggingface/transformers`
   - `@filoz/synapse-core`, `@filoz/synapse-sdk`, `viem`, `multiformats`
   - `tsx` (runtime uses compiled `dist/`)
   - all `optionalDependencies`
3. Pin kept dependencies to exact `pnpm list --depth 0 --prod` versions
4. `pnpm install --prod --ignore-scripts --ignore-workspace` in
   `.deno-compile-staging/` with `node-linker=hoisted` (not `pnpm deploy`;
   deploy copies the full isolated `.pnpm` store and Deno compile times out)
5. `deno compile --no-check --node-modules-dir=manual` with `--allow-write` and
   `--include` for `openapi.json`, `openapi.yaml`, `package.json`,
   `dist/db/migrations`

### Why not `--node-modules-dir=auto`?

Against the monorepo pnpm tree it embeds the full dependency graph (~774 MB).
Against the hoisted lean tree, `--manual` is enough and much smaller.

### Why not `--bundle` alone?

esbuild still follows string-literal dynamic imports into
`@huggingface/transformers` and Filecoin providers, so those packages stay
in the embed unless they are removed from the staging dependency set.

### Entrypoint note

`src/bin.ts` treats Deno `import.meta.main` and any basename starting with
`atomicmemory-core` as the CLI entrypoint (needed for compiled binaries).

## Embedded assets

| Asset | Consumer |
|-------|----------|
| `openapi.json` | `dist/app/openapi-spec.js` |
| `openapi.yaml` | optional parity |
| `package.json` | migration schema fingerprint |
| `dist/db/migrations/*.sql` | `dist/db/migration-schema.js` |

## Follow-ups

1. Further shrink with `--bundle` **after** lean staging (opaque dynamic imports
   or stubs for Filecoin JS still present in `dist/`).
2. Optional “full” profile binary that re-adds transformers/Filecoin.
3. Cross-compile (`--target`) and CI artifact once size/profile are stable.

## macOS DMG consumer

For the AtomicMemory Mac app embedded runtime, see:

- [macos-embedded-runtime.md](./macos-embedded-runtime.md) — env contract, ports, artifact names
- [darwin-pgvector-pack.md](./darwin-pgvector-pack.md) — Postgres pack build
- `scripts/macos-embedded-entrypoint.sh` — lifecycle entrypoint
- am-app [ADR 0002](https://github.com/atomicstrata/am-app/blob/main/docs/decisions/0002-embedded-local-runtime.md)

CI produces `atomicmemory-core-darwin-arm64` on macOS runners via `.github/workflows/core-deno-compile-macos.yml`.

## Explicit non-goals (unchanged)

- Postgres/pgvector inside the binary
- Docker embedded-Postgres parity
- Replacing `@atomicmemory/core` npm `bin` or Dockerfile

## Rollback

Remove `scripts/deno-compile-core.sh`, this doc, and `dist-bin/` /
`.deno-compile-staging/` (gitignored). Revert `src/bin.ts` entrypoint tweak
if unused. No production surfaces change.
