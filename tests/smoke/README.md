# AtomicMemory Public Smoke

This workspace package owns the public-safe smoke contract for the
AtomicMemory monorepo. It is intentionally data-first: the contract describes
which packages, framework adapters, and host plugins are covered by public
smoke checks without importing release orchestration.

## Contract

The contract lives at
[`docs-contract/public-smoke-contract.json`](docs-contract/public-smoke-contract.json).
Each row declares:

- package, adapter, or plugin kind;
- monorepo target path;
- registry or host artifact when public;
- `required_for_public_release`;
- coverage label;
- publish status;
- install type;
- public install command when the artifact is already published.

`@atomicmemory/langchain`, `@atomicmemory/langgraph`, and
`@atomicmemory/mastra` are published package-protocol rows with public install
commands. Codex and Cursor plugin rows remain `coming_soon` and are not
required for public release until host marketplace validation is complete.

## Validation

Run the public contract check from this package:

```bash
pnpm run docs-contract
```

The validator uses `jq` only and checks the contract shape, required flags,
publish-status invariants, and coverage-label policy. It does not include
release-operations checks, sync tooling, container orchestration, or host-auth
checks.

## Partial Runs

Only the full public smoke suite can contribute to public release readiness.
Subset, selected, and partial smoke runs are diagnostic only. They are useful
for local iteration and CI debugging, but they must not be reported as a public
release-ready result.
