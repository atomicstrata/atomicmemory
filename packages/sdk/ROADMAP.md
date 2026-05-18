# AtomicMemory SDK Roadmap

This roadmap is directional. It describes the areas the maintainers are actively investing in, but it is not a promise of specific features or dates.

The AtomicMemory SDK provides the TypeScript interface for applications, agents, and integrations that need to capture, store, retrieve, and package memory. The near-term focus is a stable developer surface that works across local, server, and agent-oriented runtimes.

## Current Focus

- Keep the SDK API stable and aligned with AtomicMemory Core.
- Make memory capture and retrieval flows easier to use from applications and agent integrations.
- Improve provider configuration for embeddings, storage, and retrieval behavior.
- Keep local-first and self-hosted use cases straightforward.
- Add examples that show realistic memory workflows rather than isolated snippets.
- Preserve a clear separation between SDK logic and application-specific UI or extension behavior.

## Near-Term Work

### API Stability

- Clarify the public client surface for capture, search, retrieval, mutation, and context packaging.
- Tighten TypeScript types for request options, result metadata, and provider configuration.
- Document compatibility expectations across SDK and Core versions.
- Add migration notes when public behavior changes.

### Retrieval And Context Packaging

- Improve helpers for retrieving relevant memories and packaging them for model prompts.
- Expose enough metadata for applications to debug why a memory was selected.
- Add better support for correction-aware and time-sensitive memory workflows.
- Keep benchmark-driven behavior changes covered by reproducible examples or tests.

### Providers And Runtime Support

- Continue improving provider interfaces for embeddings, storage, and transport.
- Document recommended provider choices for common local and server deployments.
- Keep browser, Node.js, and server-side usage boundaries explicit.
- Avoid application-specific assumptions in the SDK layer.

### Developer Experience

- Expand quickstarts and examples for common application flows.
- Improve error messages for configuration and provider failures.
- Add focused tests around public API behavior and runtime compatibility.
- Keep package metadata, badges, and release notes easy to inspect.

## Later Work

- Higher-level workflows for memory lifecycle management where they remain runtime-agnostic.
- Additional provider adapters driven by contributor and application demand.
- More structured retrieval helpers over entities, events, and relationships.
- Deeper debugging utilities for ranking, token budgets, and prompt assembly.

## Contribution Areas

Good first areas for contributors include:

- Type improvements and documentation for public APIs.
- Small examples that show real capture, retrieval, and context assembly flows.
- Provider adapter fixes and compatibility tests.
- Bug reports with minimal reproduction projects.
- Tests that protect behavior across supported runtimes.

## Non-Goals

- The SDK should not contain browser-extension UI logic.
- The SDK should not require a hosted AtomicMemory service.
- The SDK should not expose unreleased roadmap, benchmark, or customer-specific planning details.
- The SDK should not hide provider behavior behind uninspectable defaults.

## How We Prioritize

We prioritize changes that make the SDK easier to adopt safely: stable APIs, clear examples, predictable runtime behavior, and testable retrieval improvements.
