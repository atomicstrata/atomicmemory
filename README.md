# AtomicMemory

**Portable semantic memory for agents and applications.**

AtomicMemory is a memory layer you embed where your AI code already runs. Capture
context, ground generations in prior interactions, and carry knowledge across
sessions — from a direct SDK call, a CLI, an MCP server, a framework adapter, or
a host plugin. Local-first where supported, hosted where convenient, and
designed so the choice can change later without rewriting your application.

This repository is the public source of truth for the AtomicMemory JavaScript /
TypeScript packages, framework adapters, host plugins, and public smoke tests.

## Why AtomicMemory

- **Portable**: a single memory protocol consumed by direct SDK calls, CLIs,
  the MCP server, framework adapters, and host plugins. The same memory store
  serves a LangGraph agent, a Claude Code session, and a custom Vercel AI
  application without re-implementing capture or retrieval semantics.
- **SDK-agnostic**: every adapter is built on the same SDK. Adapters are
  conveniences, not gatekeepers. You can drop down to the SDK at any time and
  keep the same data, indexes, and retrieval behavior.
- **Local or hosted, your choice**: the core engine runs locally for
  privacy-sensitive workloads. The hosted profile is available where it makes
  sense and is marked clearly in the package matrix below. There is no
  capability cliff between the two.
- **No lock-in**: package APIs are stable and semver-disciplined. Migrating
  between direct SDK use, adapters, and host plugins is documented and does not
  require re-ingesting your data. You own your memory store.

## Performance posture

We make supportable performance claims, not marketing ones. Concrete numbers
for ingestion latency, retrieval latency, recall@k, and scale envelope are
published only with a linked benchmark, the hardware and dataset used, and the
date the measurement was taken. Benchmark code and fixtures live in this repo
under `tests/` so anyone can reproduce a result before quoting it.

Until a benchmark is linked from the docs, treat the engine as "designed for
single-digit-ms local retrieval on a developer laptop at typical agent corpus
sizes" — a design target, not a guarantee. Concrete numbers and a published
benchmark suite land in a phased follow-up; this README will link them when
they are reproducible.

## Quickstart

These commands use only currently-published packages. Adapters and surfaces
that are implemented but not yet on the registry are listed in the package
matrix below and are not part of the main install path.

```bash
# direct SDK
npm install @atomicmemory/sdk

# CLI
npm install -g @atomicmemory/cli

# framework adapter (example: Vercel AI SDK)
npm install @atomicmemory/vercel-ai @atomicmemory/sdk
```

The minimal example, environment setup, and the full list of supported hosts
and frameworks live in the docs site linked below. Adapter and plugin install
contracts (install type, local-core requirement, hosted-mode status) appear at
the top of each integration page.

## Package matrix

Status labels follow the docs contract:

- **published** — available on the npm registry and supported.
- **implemented, publish pending** — code lives in this repo and works locally,
  but the first monorepo-era release has not been cut yet. Do not put these in
  install commands until the row flips to `published`.
- **private** — intentionally not published while a host validator or posture
  decision is pending. Lock-step version bumps continue alongside the public
  set; the public release contract does not include these yet.
- **unsupported** / **planned** — reserved for future entries.

### Packages

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/core` | `packages/core` | published |
| `@atomicmemory/sdk` | `packages/sdk` | published |
| `@atomicmemory/cli` | `packages/cli` | published |
| `@atomicmemory/mcp-server` | `packages/mcp-server` | published |

### Framework adapters

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/vercel-ai` | `adapters/vercel-ai` | published |
| `@atomicmemory/openai-agents` | `adapters/openai-agents` | published |
| `@atomicmemory/langchain` | `adapters/langchain` | implemented, publish pending |
| `@atomicmemory/langgraph` | `adapters/langgraph` | implemented, publish pending |
| `@atomicmemory/mastra` | `adapters/mastra` | implemented, publish pending |

### Host plugins

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/claude-code-plugin` | `plugins/claude-code` | published |
| `@atomicmemory/openclaw-plugin` | `plugins/openclaw` | published |
| `@atomicmemory/hermes-plugin` | `plugins/hermes` | published |
| `@atomicmemory/codex-plugin` | `plugins/codex` | private |
| `@atomicmemory/cursor-plugin` | `plugins/cursor` | private |

Codex and Cursor plugins remain private until the host marketplace manifest
format is validated end to end. Lock-step plugin version bumps continue for
those packages alongside the public set; the public release contract simply
does not include them yet.

### Other surfaces

| Surface | Location | Status |
| --- | --- | --- |
| Python SDK (`atomicmemory` on PyPI) | separate repository | published; not part of this monorepo for launch |

## Local development

The skeleton uses pnpm workspaces with Turborepo as the task graph and cache
layer. pnpm owns dependency resolution, workspace linking, and packing. Turbo
owns task ordering, caching, and affected-task selection.

```bash
# install (uses the pinned pnpm@9.0.0 from packageManager)
pnpm install

# build / typecheck / test (cacheable)
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run lint

# release / hygiene gates (not cached; always re-run)
pnpm run pack-dry-run
pnpm run package-metadata
pnpm run docs-contract
pnpm run public-integration-smoke
pnpm run repo-hygiene
pnpm run security-compliance
```

The first four lanes are deterministic and cached. The bottom group is
explicitly `cache: false` in `turbo.json` because they have side effects, talk
to external services, or must always reflect current repo state.

CI lanes use thin aliases over the same Turbo tasks:

```bash
pnpm run ci:affected         # build / typecheck / test / lint, affected-only
pnpm run ci:pack-dry-run     # pack-dry-run, affected-only
pnpm run ci:docs-contract    # docs-contract
pnpm run ci:public-smoke     # public-integration-smoke
```

`ci:affected` and `ci:pack-dry-run` use Turbo's `--affected` filter for normal
PRs; full release-green validation runs the unprefixed scripts so the required
surface is never narrowed by affected detection.

Per-package commands (`pnpm --filter @atomicmemory/sdk run build`, etc.) work
once a package lands in `packages/`, `adapters/`, or `plugins/`. The skeleton
intentionally ships no source yet; packages copy in as part of the phased
migration.

## Repository layout

```text
packages/      core, sdk, cli, mcp-server
adapters/      framework integrations (Vercel AI, OpenAI Agents, LangChain,
               LangGraph, Mastra)
plugins/       host integrations (Claude Code, OpenClaw, Hermes, Codex, Cursor)
examples/      reserved for phase 2+; only added with owners and CI coverage
tests/smoke/   public, contributor-safe smoke tests
docs/          public docs surface (separate from the private docs source)
```

Internal release orchestration, operator runbooks, private launch checklists,
and developer-machine paths are deliberately not part of this repository.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, branch protection
rules, and the public CI lanes a pull request runs through.

## Security

Security policy, supported versions, and the private vulnerability reporting
channel are documented in [`SECURITY.md`](SECURITY.md). Please report
suspected vulnerabilities privately rather than opening a public issue.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).
