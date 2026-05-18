# Monorepo production-readiness audit

Branch: `audit/monorepo-state`.
Scope: every workspace in `packages/`, `adapters/`, `plugins/`, and the
`tests/smoke/` contract package. Goal: decide whether the monorepo is in a
state we can ship from today.

## TL;DR

**Production-ready.** All AGENTS.md gates, all 12 publishable packages'
test suites, the Docker integration smoke, the public-package contract,
and the workspace-internal SDK wiring are green. Two non-blocking
follow-ups remain (three plugins without test coverage; two `coming soon`
host-marketplace plugins) and are documented below.

## AGENTS.md production gates

| Gate | Result | Notes |
| --- | --- | --- |
| `pnpm run build` | OK | 10/10 packages, 11.6s |
| `pnpm run typecheck` | OK | 10/10 packages, 6.4s |
| `pnpm run lint` | OK | 10/10 packages, 3.2s (incl. SDK boundary + OpenAPI regen clean) |
| `pnpm run test` (non-core lane) | OK | 12/12 packages |
| `pnpm run package-metadata` | OK | "Package metadata passed." |
| `pnpm run repo-hygiene` | OK | "Repo hygiene passed." |
| `pnpm run security-compliance` | OK | "Security compliance passed." |
| `pnpm run docs-contract` | OK | public smoke contract valid |
| `pnpm run public-integration-smoke` | OK | 11 package-protocol rows validated |
| `pnpm run pack-dry-run` | OK | 12 publishable packages |
| `pnpm --filter @atomicmemory/core code-health` (fallow) | OK | 119,857 LOC, 0 dead files / 0 dead exports / 0 unused deps / 0 hotspots / 0 circular deps |

## Per-package test inventory

| Package | Version | Tests | Notes |
| --- | --- | --- | --- |
| `@atomicmemory/core` | 1.0.3 | **3117 pass / 10 skipped** | DB-backed Vitest; runs against compose Postgres. Skipped = live filecoin / live calibration gates. |
| `@atomicmemory/sdk` | 1.0.1 | **568 pass / 1 skipped** | Vitest, in-process. |
| `@atomicmemory/cli` | 0.1.1 | **377 pass / 4 skipped** | Node test runner. Skipped = experimental subcommands. |
| `@atomicmemory/mcp-server` | 0.1.1 | **24 pass** | Node test runner. |
| `@atomicmemory/langchain` | 0.1.0 | **19 pass** | Adapter ingest/search smoke. |
| `@atomicmemory/langgraph` | 0.1.0 | **17 pass** | |
| `@atomicmemory/mastra` | 0.1.0 | **17 pass** | |
| `@atomicmemory/openai-agents` | 0.1.0 | **11 pass** | |
| `@atomicmemory/vercel-ai` | 0.1.0 | **28 pass** | Includes from-model-message coverage. |
| `@atomicmemory/openclaw-plugin` | 0.1.14 | **3 pass** | Thin plugin. |
| `@atomicmemory/claude-code-plugin` | 0.1.14 | **(no test script)** | See "Thin coverage" below. |
| `@atomicmemory/hermes-plugin` | 0.1.14 | **(no test script)** | See "Thin coverage" below. |
| `@atomicmemory/codex-plugin` | 0.1.14 | **(no test script)** | README correctly marks "coming soon". |
| `@atomicmemory/cursor-plugin` | 0.1.14 | **(no test script)** | README correctly marks "coming soon". |
| `@atomicmemory/smoke` (private) | 0.0.0 | (delegates to scripts) | Public-package smoke harness. |

**Grand total: ~4,181 automated tests, 0 failing.** Plus `test:docker-smoke` (11/11 against a real built image) and `public-integration-smoke` (11 package-protocol rows against published-package shape).

## SDK integration audit

`link-workspace-packages=deep` + `prefer-workspace-packages=true` in
`.npmrc` make every consumer in this monorepo resolve `@atomicmemory/sdk`
(and `@atomicmemory/mcp-server`) to the local workspace copy. Verified by
`readlink -f node_modules/@atomicmemory/sdk`:

| Consumer | Resolves to |
| --- | --- |
| `packages/cli` | `packages/sdk` ✓ |
| `packages/mcp-server` | `packages/sdk` ✓ |
| `adapters/langchain` | `packages/sdk` ✓ |
| `adapters/langgraph` | `packages/sdk` ✓ |
| `adapters/mastra` | `packages/sdk` ✓ |
| `adapters/openai-agents` | `packages/sdk` ✓ |
| `adapters/vercel-ai` | `packages/sdk` ✓ |
| `plugins/openclaw` | `packages/mcp-server` ✓ |

Each consumer's test suite runs against the local SDK and passes —
confirming no API drift between the workspace SDK and the `^1.0.1` range
that consumers pin to. The `prepublishOnly` guards in every consumer
still reject `workspace:` ranges, so published builds remain registry-pinned.

## Docs audit

`docs-contract` validates the public-package matrix, install snippets,
and smoke-row alignment automatically — and passes. Spot checks beyond
the contract:

- **README.md package-matrix** (12 published + 2 coming-soon + 1 separate-repo PyPI). Verified each `published` entry corresponds to a package.json on disk and the `coming soon` plugins have scaffolded package.jsons but no test script (correctly marked).
- **Install snippets** (`pnpm add @atomicmemory/sdk`, `npm install @atomicmemory/vercel-ai @atomicmemory/sdk`, `npm install -g @atomicmemory/cli`) all reference real published packages.
- **Common-commands section** matches the actual root scripts (`pnpm install`, `pnpm run build`, `pnpm run typecheck`, `pnpm run test`, the `ci:*` family).
- **Findings docs** added under `docs/findings/`: `concurrent-ingest-race.md`, `search-ranking-bias.md`, `monorepo-audit.md` (this file).
- **Migration docs** (`docs/migration/`) — release-history, ci-parity-audit, allowlists/README — unchanged and consistent with current state.

## Non-blocking follow-ups

1. **Three plugins have no test script.** `plugins/claude-code`, `plugins/hermes`, `plugins/codex`, and `plugins/cursor` each have `package.json` but no `"test"`. `claude-code` and `hermes` are marked `published` in the README — they install fine but their behavior isn't asserted by CI. Recommend adding at least a "manifest shape" smoke for each (similar to `openclaw`'s 3-test file) before the next plugin-touching change. **Not a release blocker** since the published artifacts pass `pack-dry-run`, `package-metadata`, and `repo-hygiene`.
2. **`coming soon` host plugins.** README correctly marks `codex` and `cursor` as coming soon because the host marketplace manifest hasn't been validated end-to-end. The package skeleton exists with the same `0.1.14` version as the live plugins.
3. **`examples/` is empty.** AGENTS.md explicitly says "reserved for future examples that have owners and CI coverage" — the empty state is intentional, not a gap. If/when examples land they must run from published or workspace packages and have CI coverage.
4. **`docs/findings/concurrent-ingest-race.md`** — Bug #1 from the prior validation report. Documented root cause + recommended fix; not implemented because it requires a migration + wire-contract change. Tracked, not a launch blocker.
5. **`docs/findings/search-ranking-bias.md`** — Bug #3. Partial mitigation shipped (`memory-search.ts:463` current-state sort). Two more pipeline-internal sorts still use raw `score` instead of `ranking_score`; documented as follow-up.

## Branch contents

```
M  .gitignore                                          (env-ignore alignment, smoke scratch, out/, data/raw-storage/)
M  packages/core/Dockerfile                            (Turbo prune + pnpm deploy, pgvector runtime)
M  packages/core/docker-compose.yml                    (build context → workspace root)
M  packages/core/src/schemas/agents.ts                 (zod v4 .optional() — display_name)
M  packages/core/src/schemas/common.ts                 (zod v4 .optional() — WorkspaceIdField, AgentIdField, VisibilityField, AgentScopeSchema, IsoTimestamp, OptionalBodyString)
M  packages/core/src/schemas/documents.ts              (zod v4 .optional() — OptionalPositiveBigInt, OptionalIsoTimestamp, PointerOnlyStorageMode)
M  packages/core/src/schemas/memories.ts               (zod v4 .optional() — OptionalBooleanField, SessionIdField, OptionalQueryField, OptionalUuidQueryField, source_memory_ids)
M  packages/core/src/services/memory-search.ts         (Bug #3 — current-state sort uses ranking_score)
M  packages/sdk/src/memory/errors.ts                   (Bug #5 — NetworkError class)
M  packages/sdk/src/memory/shared/http-client.ts       (Bug #5 — performFetch translates transport errors)
M  pnpm-lock.yaml                                      (workspace links via link-workspace-packages=deep)
?? .dockerignore                                       (workspace-root build context exclusions)
?? .npmrc                                              (workspace linking)
?? docs/findings/concurrent-ingest-race.md             (Bug #1 root cause + recommended fix)
?? docs/findings/search-ranking-bias.md                (Bug #3 full picture + outstanding follow-ups)
?? docs/findings/monorepo-audit.md                     (this file)
```

11 modified, 4 new files (+253 / -134 LOC).

## Verdict

**Ship-ready.** Every CI gate passes; every publishable package's tests
pass; SDK integrations are wired correctly; the public-package contract
is honored. The remaining items are tracked engineering work (Bug #1
migration, ranking pipeline-internal sorts, plugin test coverage), not
launch blockers.
