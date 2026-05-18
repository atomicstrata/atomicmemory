# AtomicMemory Roadmap

This roadmap is directional. It describes the areas the maintainers are
actively investing in, but it is not a promise of specific features or dates.

AtomicMemory is the public monorepo for the JavaScript/TypeScript memory engine,
SDK, framework adapters, host plugins, and public validation harness. The
near-term focus is making memory portable across direct SDK use, framework
integrations, MCP, and host plugins while keeping the product surface simple and
auditable.

## Current Focus

- Keep the SDK, Core, adapters, and plugins aligned around one memory protocol.
- Make public install paths work from published packages without cloning source
  repositories.
- Keep framework adapters thin and SDK-owned so users can move between direct
  SDK use and adapter use without changing memory behavior.
- Improve host plugin setup, diagnostics, and manifest validation.
- Publish reproducible performance evidence before making specific latency,
  recall, or scale claims.
- Keep public CI focused on package metadata, smoke contracts, security gates,
  and contributor-safe validation.

## Near-Term Work

### Core And SDK

- Stabilize public APIs for capture, search, retrieval, mutation, and context
  packaging.
- Keep local, self-hosted, and hosted usage boundaries explicit.
- Improve diagnostics for provider configuration, storage setup, and retrieval
  behavior.
- Add service-provisioned validation for DB-backed Core tests in the monorepo
  CI surface.

### Framework Adapters

- Keep adapters small, typed, and framework-idiomatic.
- Publish implemented adapters after package metadata, smoke coverage, and docs
  install commands are ready.
- Maintain clear guidance for Vercel AI SDK, OpenAI Agents SDK, LangChain,
  LangGraph, and Mastra users.
- Add examples only when they have owners and CI coverage.

### Host Plugins And MCP

- Keep the MCP server stable for memory capture, retrieval, search, and context
  packaging workflows.
- Improve install and doctor-style diagnostics for supported hosts.
- Validate marketplace manifest behavior before publishing or promoting host
  plugins.
- Keep Codex and Cursor plugin packages unpublished until their host install
  paths are verified end to end.

### Docs And Public Contracts

- Keep README, package metadata, docs commands, and smoke contract rows in sync.
- Make package status labels explicit: published, implemented publish pending,
  coming soon, planned, or unsupported.
- Document performance claims only with linked benchmark code, environment,
  dataset, and measurement date.
- Keep package docs and contract files aligned with the current public package
  matrix.

## Later Work

- Service-backed Core test lane in public CI.
- Reproducible benchmark suite for local retrieval, ingestion, and recall
  claims.
- More runnable examples for common application and agent workflows.
- Additional adapters and plugins based on user demand and host maturity.
- Revisit Python SDK placement after the JavaScript/TypeScript monorepo is
  stable.

## Contribution Areas

Good first areas for contributors include:

- Small docs fixes that clarify install, package status, or adapter boundaries.
- Minimal reproductions for SDK, adapter, CLI, MCP, or plugin issues.
- Tests that protect public package behavior and smoke contract rows.
- Framework examples that use published packages and can run in CI.
- Package metadata fixes for repository links, exports, files, and docs.

## Non-Goals

- The monorepo should not include release orchestration or sensitive operational
  runbooks.
- Adapters and plugins should not reimplement Core or SDK memory behavior.
- Public docs should not expose sensitive infrastructure, customer-specific
  work, or release operations.
- Examples should not land without ownership and validation coverage.
- The repository should not make benchmark or performance claims without
  reproducible evidence.

## How We Prioritize

We prioritize changes that make AtomicMemory easier to adopt safely: stable
package APIs, clear install paths, predictable local and hosted behavior,
reproducible validation, and integrations that stay thin over the SDK/Core
contract.
