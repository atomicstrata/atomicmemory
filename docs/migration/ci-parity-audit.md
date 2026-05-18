# CI Parity Audit

This audit maps the pre-monorepo public repository checks to the current
monorepo CI lanes. The goal is to keep each former repository's release-safety
checks visible while moving package-scoped work behind Turborepo.

## Current Monorepo Lanes

| Lane | Entry point | Turbo usage | Purpose |
| --- | --- | --- | --- |
| `repo-hygiene` | `node scripts/ci/repo-hygiene.mjs` | Repo-level script | Reject internal references, unsafe repository shape, and stale migration inventories. |
| `package-metadata` | `node scripts/ci/package-metadata.mjs` | Repo-level script | Validate package metadata, repository directories, publish posture, and README/license presence. |
| `affected-build-test` | `pnpm run ci:affected` | `turbo run build typecheck lint --affected` and `turbo run test --affected` | Run affected package build, typecheck, lint, and self-contained tests on Node 22 and 24. |
| `code-health` | `pnpm run ci:code-health` | `turbo run code-health --affected`, with full fallback | Run package-local fallow gates for packages that had historical code-health requirements. |
| `pack-dry-run` | `pnpm run ci:pack-dry-run` | `turbo run pack-dry-run --affected` | Build affected packages and validate packed tarball metadata. |
| `docs-contract` | `pnpm run ci:docs-contract` | `turbo run docs-contract` | Validate public docs command contracts and smoke-contract JSON. |
| `public-integration-smoke` | `pnpm run ci:public-smoke` | `turbo run public-integration-smoke` | Run the public package and host integration smoke contract. |
| `security-compliance` | `node scripts/security/security-compliance.mjs` | Repo-level script | Validate security/compliance posture that is not package-local. |

## Legacy Check Mapping

| Source repository | Legacy check | Monorepo status |
| --- | --- | --- |
| `atomicmemory-core` | Node 22 install/build/test with Postgres service | Partially mapped. Build/typecheck/OpenAPI drift check run through `affected-build-test`; DB-backed tests are tracked as a follow-up because they require a Postgres service lane. |
| `atomicmemory-core` | `npx tsc --noEmit` | Mapped to `packages/core` `typecheck`, run by `turbo run typecheck`. |
| `atomicmemory-core` | `npm run check:openapi` | Mapped to `packages/core` `lint`, run by `turbo run lint`. |
| `atomicmemory-core` | Strict `fallow --fail-on-issues` | Mapped to `packages/core` `code-health`, run by `turbo run code-health`. |
| `atomicmemory-core` | Schemathesis schema fuzzing | Deferred follow-up. The existing `packages/core` `test:schema` script remains available; CI needs a dedicated service-backed lane before it becomes a hard monorepo gate. |
| `atomicmemory-sdk` | Node 22/24 typecheck, build, coverage tests | Mapped to `affected-build-test` on Node 22 and 24. |
| `atomicmemory-sdk` | Fallow audit with coverage, health baseline, dupe baseline, and ratchet | Mapped to `packages/sdk` `code-health`, run by `turbo run code-health`. |
| `atomicmemory-sdk` | No application-layer imports boundary check | Mapped to `packages/sdk` `boundary:check`, included in `packages/sdk` `lint`. |
| `atomicmemory-integrations` | Node 22/24 build, typecheck, lint, and tests | Mapped to `affected-build-test` on Node 22 and 24. |
| `atomicmemory-integrations` | Python 3.11 setup for Hermes tests | Mapped to `affected-build-test` with `actions/setup-python@v5`. |
| `atomicmemory-integrations` | Package and plugin publish shape checks | Mapped to `pack-dry-run`, `package-metadata`, and `public-integration-smoke`. |

## Follow-Up Gaps

These checks are intentionally not converted in this PR because they need
service orchestration or release credentials rather than package-local Turbo
tasks:

- `packages/core` DB-backed test lane with a Postgres/pgvector service.
- `packages/core` Schemathesis schema fuzzing lane and its artifact uploads.
- Docker image build/smoke and GHCR publish validation for release workflows.
- npm publish/OIDC provenance workflows for release tags.

## Provenance Validation

`scripts/ci/migration-inventories.mjs` generates and verifies
`docs/migration/inventories/*.json` from the committed source snapshot
manifest. This is a repository-level provenance check, so it runs from
`repo-hygiene` instead of as a package task. Package-local checks still flow
through Turborepo where affected detection and dependency ordering are useful.
