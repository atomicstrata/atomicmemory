# AtomicMemory Core Roadmap

This roadmap is directional. It describes the areas the maintainers are actively investing in, but it is not a promise of specific features or dates.

AtomicMemory Core is the self-hosted memory engine for applications and agents that need durable, inspectable, and queryable long-term memory. The near-term focus is making the engine reliable to run, easy to evaluate, and clear to extend.

## Current Focus

- Make the local and self-hosted quickstart predictable across Docker, Postgres, and pgvector.
- Keep the HTTP API and TypeScript SDK surface aligned so clients can rely on stable request and response shapes.
- Improve retrieval quality for multi-session, correction-heavy, and time-sensitive memory workflows.
- Make mutation behavior easier to reason about, including updates, deletions, and conflict handling.
- Expand observability around capture, retrieval, ranking, and memory lifecycle decisions.
- Strengthen project readiness for public contributors: setup docs, issue templates, security policy, and contribution paths.

## Near-Term Work

### Runtime And Deployment

- Document the supported Docker and local-development paths.
- Add clearer health checks and startup validation for required services.
- Improve configuration documentation for embedding providers, database settings, and API service settings.
- Keep generated API documentation in sync with the implemented routes.

### Retrieval Quality

- Improve hybrid retrieval behavior across semantic, lexical, and structured signals.
- Add better handling for corrections, stale facts, and conflicting memories.
- Expand ranking diagnostics so contributors can understand why a memory was returned.
- Keep benchmark-driven quality gates tied to reproducible test artifacts.

### Memory Lifecycle

- Clarify the model for creating, updating, deleting, and superseding memories.
- Improve auditability for memory mutations and derived memory artifacts.
- Add safer defaults around destructive operations.
- Document the intended behavior for canonical memories versus derived summaries or indexes.

### Observability And Operations

- Add practical logs and metrics for ingestion, extraction, storage, retrieval, and ranking.
- Improve error messages for common setup and runtime failures.
- Document operational expectations for local development and self-hosted deployments.
- Add troubleshooting guides for database, provider, and configuration issues.

## Later Work

- More advanced structured retrieval over entities, events, and relationships.
- Additional provider support where it improves portability without weakening the core API.
- Deeper benchmark reporting for latency, cost, token usage, and quality tradeoffs.
- Optional hosted-service integration points while keeping the self-hosted engine usable on its own.

## Contribution Areas

Good first areas for contributors include:

- Reproducible bug reports for setup, API behavior, or retrieval quality.
- Improvements to examples, quickstarts, and troubleshooting docs.
- Tests that capture real memory workflows, especially updates, corrections, and multi-session recall.
- Provider adapters and configuration improvements that keep the public API stable.
- Observability improvements that make behavior easier to inspect.

## Non-Goals

- Core should not depend on a browser extension or a specific application shell.
- Core should not hide memory mutation behavior behind opaque heuristics.
- Core should not require a hosted AtomicMemory service for local or self-hosted use.
- Core should not expose unreleased benchmark strategy or customer-specific plans.

## How We Prioritize

We prioritize work that makes AtomicMemory easier to run, easier to verify, and safer to build on. Quality improvements should be tied to tests, benchmark artifacts, or clear user workflows rather than isolated implementation changes.
