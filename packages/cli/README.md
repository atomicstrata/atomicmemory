# @atomicmemory/cli

> **Deprecated.** Use the **`am`** CLI instead. See
> [`crates/cli/README.md`](../../crates/cli/README.md) for the command map and
> migration status. New features land in `am`.
>
> This package remains published and supported for
> **`import --type llmwiki`**, which has no `am` or SDK equivalent yet (the
> `@atomicmemory/llmwiki` provider is read-only), and for legacy workflows
> during transition. The commands below still work; each one except the
> llmwiki import has an `am` equivalent in the command map.
>
> There is deliberately **no runtime deprecation banner**: this CLI's output
> contracts require `--output quiet` to emit nothing at all, `--agent`/`--json`
> to keep stderr clean for machine consumers, and only `src/renderers/*` to
> write to the streams. The deprecation is surfaced in `atomicmemory help`,
> the changelog, and the smoke contract instead.

Human- and agent-facing CLI for AtomicMemory memory workflows.

This package is separate from `@atomicmemory/mcp-server`: `atomicmemory-mcp`
is a stdio protocol process for agent hosts, while `atomicmemory` is a normal
command-line tool.

## Install

From a local checkout, build and link globally:

```bash
pnpm --filter @atomicmemory/cli build
cd packages/cli
pnpm link --global

atomicmemory
```

With no arguments in a real terminal, `atomicmemory` opens the interactive
Ink UI. Use `atomicmemory help` for the plain command reference, or
`atomicmemory --no-interactive` to keep the static help behavior.

If pnpm reports `ERR_PNPM_NO_GLOBAL_BIN_DIR`, initialize pnpm's global bin
directory first, then restart or source your shell config:

```bash
pnpm setup
source ~/.zshrc
cd packages/cli
pnpm link --global
```

You can also test without global linking:

```bash
node packages/cli/dist/bin.js
```

The interactive UI can also be opened explicitly:

```bash
atomicmemory ui
atomicmemory --interactive
```

Public npm install will be:

```bash
npm install -g @atomicmemory/cli
```

That requires publishing `@atomicmemory/sdk` first. Until the SDK
exists on npm, this package keeps the same local SDK `file:` dependency used by
the rest of the integrations repo.

## Usage

```bash
atomicmemory
atomicmemory init --api-url http://127.0.0.1:17350 --user "$USER"
atomicmemory doctor
atomicmemory status
atomicmemory add "The project uses pnpm workspaces."
atomicmemory search "workspace package conventions" --limit 5
atomicmemory package "recent implementation context" --token-budget 1200
atomicmemory list --limit 20
atomicmemory get <memory-id>
atomicmemory delete <memory-id>
atomicmemory skill get core
atomicmemory hooks install --host codex --runtime node
atomicmemory validate
```

Every command accepts the same provider and scope overrides:

```bash
atomicmemory search "release policy" \
  --provider atomicmemory \
  --api-url http://127.0.0.1:17350 \
  --user "$USER" \
  --namespace atomicmemory
```

The legacy `atomicmemory memory <command>` group remains as a compatibility
alias, but the v4 command spec treats the direct commands as canonical:

```bash
atomicmemory search "release policy"
atomicmemory add "Remember this fact"
atomicmemory list
```

## Command Groups

The visible v5 surface is driven by `cli-spec.json`:

| Group | Commands |
|---|---|
| `setup` | `init`, `config`, `hooks`, `completion` |
| `diagnose` | `doctor`, `status`, `validate` |
| `agent` | `skill`, `help`, `version` |
| `memory` | `add`, `ingest`, `search`, `package`, `list`, `get`, `delete`, `import` |

Use `atomicmemory help --json` for the machine-readable command tree.

## Deprecated surfaces (not ported to `am`)

| Surface | Fate |
| --- | --- |
| `atomicmemory ui` / Ink TUI | Hard-dropped — use host tools + `am` |
| `--experimental` (`lifecycle`, `audit`, `lessons`, `agents`) | Hard-dropped |
| `--provider mem0` | Hard-dropped — use SDK/MCP |
| `atomicmemory validate` | Relocated — `pnpm run validate:cli` (maintainers) |
| `atomicmemory hooks` | Ported — use `am hooks` |
| `atomicmemory skill` | Relocated — host skill packages / docs |

## Hook runtime selection

Lifecycle hooks are implemented in **`am hooks`**. This npm package still ships
the legacy Node hook runtime for transition only.

```bash
am hooks install --host codex
am hooks install --host claude-code
```

## Agent output

Use `--agent` for stable JSON envelopes:

```bash
atomicmemory memory search "prior decisions" --agent
```

Success shape:

```json
{
  "status": "success",
  "command": "search",
  "duration_ms": 12,
  "profile": "default",
  "scope": { "user": "pip" },
  "count": 1,
  "data": {}
}
```

Errors in agent mode are emitted to stdout and exit non-zero.

## Config

The default config path is `~/.atomicmemory/config.json`.

Precedence is:

1. CLI flags
2. `ATOMICMEMORY_*` environment variables
3. local config file
4. command defaults

Memory commands require an explicit scope user from flags, environment, or
config. The CLI does not invent a user for provider-backed operations.

`atomicmemory config show` redacts API keys by default. Use
`atomicmemory init --api-key-stdin` to avoid putting a token in shell history.

## Backend smoke (Docker)

The backend-gated smoke suite (`pnpm -C packages/cli test:backend`) is skipped
unless `ATOMICMEMORY_TEST_BACKEND=1` is set against a real
`@atomicmemory/core` instance. To exercise it deterministically against a
local Docker stack, run:

```bash
pnpm -C packages/cli test:backend:docker
```

The harness (`scripts/test-backend-docker.mjs`) brings up
`docker-compose.yml` + `docker-compose.smoke.yml` from `packages/core`,
layers a small CLI-side overlay
(`scripts/docker/docker-compose.cli-backend.yml`) that routes core's
LLM at an in-network mock so `/v1/memories/ingest` doesn't 401 on
core's smoke `OPENAI_API_KEY=sk-smoke-test-dummy`, polls the real
`/health` endpoint with a bounded 90-second timeout (no sleep-only
readiness), runs `pnpm build` + the backend suite against the resolved
API URL, then tears the stack down. No external API credentials are
required.

Configuration env vars (all optional):

| Var | Default | Purpose |
| --- | --- | --- |
| `ATOMICMEMORY_CORE_PATH` | sibling `../core` | path to the core package root |
| `ATOMICMEMORY_DOCKER_APP_PORT` | first free port from 3060 | host port for core's app |
| `ATOMICMEMORY_DOCKER_POSTGRES_PORT` | first free port from 5444 | host port for core's pg |
| `ATOMICMEMORY_DOCKER_HEALTH_TIMEOUT` | `90` (seconds) | bounded `/health` poll cap |
| `ATOMICMEMORY_DOCKER_HEALTH_INTERVAL` | `2` (seconds) | poll interval |
| `ATOMICMEMORY_DOCKER_SKIP_BUILD` | `0` | reuse existing compose images |
| `ATOMICMEMORY_DOCKER_KEEP_UP` | `0` | leave the stack up after the run for inspection |

Requirements: `docker` daemon running, `docker compose` v2 plugin,
`pnpm`, and `packages/core` containing both
`docker-compose.yml` and `docker-compose.smoke.yml`.
