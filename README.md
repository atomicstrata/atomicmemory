# AtomicMemory

[![CI](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml/badge.svg)](https://github.com/atomicstrata/atomicmemory/actions/workflows/ci.yml)
[![Core npm](https://img.shields.io/npm/v/%40atomicmemory%2Fcore?label=core)](https://www.npmjs.com/package/@atomicmemory/core)
[![SDK npm](https://img.shields.io/npm/v/%40atomicmemory%2Fsdk?label=sdk)](https://www.npmjs.com/package/@atomicmemory/sdk)
[![Docker](https://img.shields.io/badge/docker-GHCR-2496ED?logo=docker&logoColor=white)](packages/core/Dockerfile)
[![Docs](https://img.shields.io/badge/docs-docs.atomicstrata.ai-blue)](https://docs.atomicstrata.ai)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Inspectable, correction-aware memory for agents and AI applications.**

AtomicMemory gives agents durable context across sessions without coupling your
application to one model, framework, or deployment. Start with managed Hosted
Cloud, run the open-source Core locally, or integrate through the TypeScript SDK
and MCP server.

[Documentation](https://docs.atomicstrata.ai) ·
[Hosted Cloud](https://memory.atomicstrata.ai) ·
[Open-source quickstart](https://docs.atomicstrata.ai/open-source/quickstart) ·
[Why inspectable memory matters](https://www.atomicstrata.ai/blog/the-ai-memory-industry-has-a-black-box-problem)

## Headline Results

AtomicMemory v66 is leading performance/cost on BEAM-100K, BEAM-1M, and LoCoMo10 under
matched methodology against published competitors. On BEAM-10M it matches the
strongest published Mem0-new result while leaving Hindsight-scale temporal
retrieval as the known open frontier.

| Benchmark | AtomicMemory v66 | Position | Cost/Q | Sample |
|---|---:|---|---:|---:|
| **BEAM-100K lenient** | **0.7375** | Parity with Hindsight at 0.75 | $1.26 | n=80 |
| **BEAM-1M lenient** | **0.6625** | Leading Performance/Cost; +0.022 vs Mem0 paper | $0.083 | n=80 |
| **BEAM-10M lenient** | **0.4875** | Parity with Mem0-new at 0.486 | $0.081 | n=80 |
| **LoCoMo10 GPT-4o-mini binary** | **0.8396** | Leading Performance/Cost; +0.171 vs Mem0 paper | $0.066 | n=1540 |

These results put AtomicMemory at or near the published ceiling in each
reported category while preserving the lower-cost operating profile that
matters for real applications. Reproducibility artifacts and harness details
will be published with the benchmark materials.

## Quickstart

Install the `am` CLI and initialize Hosted Cloud in one guided command:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://get.atomicstrata.ai/install.sh | sh -s -- --init
```

Plain `am init` defaults to managed Cloud, selects your project, and saves its
project-bound credential. Managed server keys use a per-installation name such
as `am-cli-a1b2c3d4e5f6`, so another machine's credential is not rotated. No
Docker or OpenAI key is required.
Non-interactive Cloud automation uses `am init --yes --project <cloud-id>`;
Local automation must opt in with `am init --local --yes`.

The installer runs initialization through the verified binary directly. If it
updates PATH, open a new terminal before the next commands or use the
shell-specific activation command it prints.

Store a preference and retrieve it:

```bash
am memory ingest "I prefer aisle seats when flying."
am memory search "seat preference"
```

Connect the active profile to an agent host when you are ready:

```bash
am integrate --yes --host cursor # or claude-code / codex
```

`am integrate` writes the host's user-level MCP configuration. It does not
install a marketplace plugin.

## Choose your path

| Path | Best for | Start here |
| --- | --- | --- |
| **Hosted Cloud** | Managed memory with the fastest setup | Guided installer above, or `am init` |
| **Connected Local** | Running open-source Core on your machine | `am init --local` |
| **TypeScript SDK** | Server-side application integration against Core | `npm install @atomicmemory/sdk` |

Agent integration through MCP works with either an active Cloud or Local
profile. See the [documentation](https://docs.atomicstrata.ai) for framework and
host-specific guides.

## Why AtomicMemory

- **Correction-aware** — supersede, clarify, delete, or retain memories as facts
  change instead of treating memory as append-only recall.
- **Portable** — use one memory protocol through the CLI, MCP server, SDK,
  framework adapters, and host plugins.
- **Inspectable** — run the open-source Core and audit the mutation and retrieval
  path rather than depending only on a hosted black box.
- **Model-flexible** — keep extraction, embeddings, mutation, reranking, and
  retrieval packaging behind explicit provider boundaries.
- **Cloud or Local** — begin with managed Cloud or operate Core yourself without
  rewriting the integration surface.

## Use AtomicMemory

### Hosted Cloud

Interactive `am init` offers **Hosted Cloud** as option 1/default and
**Connected Local** as option 2. Hosted Cloud needs no Docker or OpenAI key:

- With one project, the CLI selects it automatically. With multiple projects,
  it prompts for a selection.
- With no project, it opens onboarding and waits for project creation in an
  interactive terminal. Non-interactive runs print the URL and recovery command
  instead of waiting.
- Credentials are bound to the Cloud origin and project, stored with owner-only
  permissions, and never printed.
- A working stored project credential is reused. Otherwise the CLI rotates only
  this installation's exact `am-cli-<12-hex>` key and creates it when absent.
  Legacy unsuffixed keys and other installations' keys are left untouched.

`--project` accepts a unique ID or case-insensitive slug and infers Cloud versus
Local from the resolved project type. Explicit selectors assert the type:

```bash
am init --project <id-or-slug>          # infer Cloud or Local
am init --cloud --project <cloud-id>    # require a Cloud project
am init --local --project <local-id>    # require a Local project
```

Ambiguous slugs fail with a request for the unique project ID. At the API-key
limit, initialization preserves the previous default profile and prints the
dashboard URL plus exact commands to list or revoke a key and retry. It never
rotates or revokes unrelated keys as quota recovery.

### Connected Local

Connected Local runs Core on your machine and can link it to Cloud for trace
visibility. It requires:

- Docker Desktop or Docker Engine running
- An [OpenAI API key](https://platform.openai.com/api-keys); interactive setup
  reads it with hidden input and stores it with owner-only permissions
- macOS or glibc Linux on x86_64 or arm64

Initialize and verify Local:

```bash
am init --local
am doctor --smoke
```

The Local defaults remain profile `local` and Core URL
`http://127.0.0.1:17350`. For headless automation, seed dashboard auth and the
OpenAI key before selecting Local explicitly:

```bash
am auth login --token "$AM_DASHBOARD_JWT"
export OPENAI_API_KEY=sk-... # inject through your secret manager
am init --local --yes
```

For Core-only Docker without a Cloud account, use the
[Core package guide](packages/core/README.md#docker-image-recommended). The
[open-source quickstart](https://docs.atomicstrata.ai/open-source/quickstart)
covers lifecycle, custom URLs, and troubleshooting; the
[CLI README](crates/cli/README.md) documents every initialization flag.

### Agent hosts and MCP

Both initialization paths leave an active profile that the published MCP server
can use. Configure a supported host with:

```bash
am integrate --yes --host cursor # or claude-code / codex
```

Codex and Cursor marketplace plugin packages remain **coming soon** in the
matrix below; direct MCP configuration through `am integrate` is a separate
supported path. Use `am integrate doctor` to diagnose host configuration.

### TypeScript SDK

The SDK is server-side only in v1. Start Core first, then reveal the Local client
environment only in a trusted terminal:

```bash
am connect env --for clients --show-secrets
npm install @atomicmemory/sdk
```

Copy `ATOMICMEMORY_CORE_URL` and `CORE_API_KEY` into the trusted server process;
never expose `CORE_API_KEY` in a browser bundle. Then use the memory client:

```ts
import { MemoryClient } from '@atomicmemory/sdk';

const memory = new MemoryClient({
  providers: {
    atomicmemory: {
      apiUrl: process.env.ATOMICMEMORY_CORE_URL!,
      apiKey: process.env.CORE_API_KEY!,
    },
  },
});

await memory.initialize();
await memory.ingest({
  mode: 'messages',
  messages: [{ role: 'user', content: 'I prefer aisle seats.' }],
  scope: { user: 'demo-user' },
});

const results = await memory.search({
  query: 'seat preference',
  scope: { user: 'demo-user' },
});
```

Use `AtomicMemoryClient` when the application also needs the storage namespace.
See the [SDK quickstart](https://docs.atomicstrata.ai/sdk/quickstart) and
[`packages/sdk/README.md`](packages/sdk/README.md) for the full API.

### Installer verification

Every CLI download is checked against `SHA256SUMS`. If an authenticated GitHub
CLI is available, the installer also verifies build provenance. Without GitHub
authentication it warns, skips optional attestation, and continues only after
checksum verification. To require attestation:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://get.atomicstrata.ai/install.sh | AM_VERIFY_ATTESTATION=1 sh -s -- --init
```

Required verification fails before installation unless `gh auth login` or
`GH_TOKEN` supplies working GitHub authentication.

## Package matrix

Status labels are part of the public docs contract:

- **published** — available on the npm registry and supported.
- **implemented, publish pending** — code lives in this repo and works locally,
  but the monorepo-era package has not been released.
- **coming soon** — source is present, but the public host install path is not
  supported yet.
- **deprecated** — still published and supported for the workflows named in
  its row, but superseded.

### Packages

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/core` | `packages/core` | published |
| `@atomicmemory/sdk` | `packages/sdk` | published |
| `@atomicmemory/cli` | `packages/cli` | deprecated (published; use `am`, still required for llmwiki import) |
| `@atomicmemory/mcp-server` | `packages/mcp-server` | published |
| `@atomicmemory/llmwiki` | `packages/llmwiki` | implemented, publish pending |

### Framework adapters

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/vercel-ai` | `adapters/vercel-ai` | published |
| `@atomicmemory/openai-agents` | `adapters/openai-agents` | published |
| `@atomicmemory/langchain` | `adapters/langchain` | published |
| `@atomicmemory/langgraph` | `adapters/langgraph` | published |
| `@atomicmemory/mastra` | `adapters/mastra` | published |

### Host plugins

| Package | Path | Status |
| --- | --- | --- |
| `@atomicmemory/claude-code-plugin` | `plugins/claude-code` | published |
| `@atomicmemory/openclaw-plugin` | `plugins/openclaw` | published |
| `@atomicmemory/hermes-plugin` | `plugins/hermes` | published |
| `@atomicmemory/codex-plugin` | `plugins/codex` | coming soon |
| `@atomicmemory/cursor-plugin` | `plugins/cursor` | coming soon |

Codex and Cursor plugin source is present, but the public host install path is
coming soon until each host marketplace manifest format is validated end to end.

### Other surfaces

| Surface | Location | Status |
| --- | --- | --- |
| CLI (`am`) | `crates/cli` | published; canonical artifacts on GitHub Releases (`get.atomicstrata.ai` mirrors them) |
| Python SDK (`atomicmemory` on PyPI) | separate repository | published; not part of this monorepo |

## Repository and trust boundaries

This repository is the public source of truth for AtomicMemory's JavaScript and
TypeScript packages, Rust CLI, framework adapters, host plugins, and public smoke
contracts. It contains:

- **Core** — Docker-deployable memory backend with mutation, retrieval, and
  Postgres/pgvector storage.
- **SDK** — typed provider boundary, memory and storage clients, embeddings, and
  search primitives.
- **CLI and MCP server** — setup, diagnostics, capture, retrieval, and agent
  integration surfaces.
- **Adapters and plugins** — thin integrations for supported frameworks and
  agent hosts.

Hosted service infrastructure, release orchestration, marketplace operations,
the Python SDK, and unpublished benchmark harnesses live outside this monorepo.
Package-specific setup remains in each package README.

### Performance posture

The Headline Results above are benchmark scores under matched methodology.
Latency, recall@k, and scale-envelope claims should only be quoted with the
benchmark, hardware, dataset, and measurement date. Until linked latency
benchmarks are available, single-digit-millisecond local retrieval remains a
design target rather than a guarantee.

### Public validation

Pull requests verify repository hygiene, package metadata, affected build and
type checks, lint, self-contained tests, package tarball shape, documentation
contracts, public integration smoke, and security compliance. Package and
release contexts additionally cover Core OpenAPI drift, schema tests, Docker
image smoke, and DB-backed Core tests when their required services are present.

## Local development

The monorepo uses pnpm workspaces and Turborepo. Check `package.json` for the
complete command surface.

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run lint
```

Core DB-backed tests require Postgres/pgvector provisioning. Rust CLI changes
use the pinned toolchain and the repository's CI-equivalent command:

```bash
pnpm run ci:rust
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, required checks,
and package-level commands. The canonical CLI source and contributor setup are
documented in [`crates/cli/README.md`](crates/cli/README.md).

## Companion: llmwiki

[llmwiki](https://github.com/atomicstrata/llmwiki) compiles raw sources into an
interlinked Markdown knowledge base. The `@atomicmemory/llmwiki` bridge imports
its JSON export into AtomicMemory while preserving advisory metadata under
`memory.metadata.llmwiki.*`.

See [`packages/llmwiki/README.md`](packages/llmwiki/README.md) and
[`packages/llmwiki/docs/cookbook.md`](packages/llmwiki/docs/cookbook.md) for the
full workflow.

## Project information

- **Release notes:** package changelogs and [`CHANGELOG.md`](CHANGELOG.md)
- **Roadmap:** [`ROADMAP.md`](ROADMAP.md)
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Security:** confidential reporting and supported versions in
  [`SECURITY.md`](SECURITY.md)
- **License:** Apache License 2.0 — see [`LICENSE`](LICENSE)

## Repository layout

```text
packages/      core, sdk, cli, mcp-server
crates/        CLI (am) and Cloud/Core wire types
adapters/      framework integrations (Vercel AI, OpenAI Agents, LangChain,
               LangGraph, Mastra)
plugins/       host integrations (Claude Code, OpenClaw, Hermes, Codex, Cursor)
examples/      reserved for phase 2+; only added with owners and CI coverage
tests/smoke/   public, contributor-safe smoke tests
```

Release orchestration, marketplace operations, sensitive service configuration,
and local machine paths are deliberately not part of this repository.
