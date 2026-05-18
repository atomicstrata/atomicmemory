# Public CI Skeleton

This directory contains public-safe checks that can run before package source is
copied into the monorepo.

## Required Root Scripts

When the root `package.json` and `turbo.json` land, the workflow expects these
root scripts to exist and to call `turbo run`:

- `ci:affected`: build, typecheck, test, and lint affected packages plus
  dependents. This lane runs on Node 22 and 24, and pins Python 3.11 so
  Python-backed host plugin tests are deterministic.
- `ci:code-health`: verify code-health coverage, run fallow for affected
  packages, and fall back to the full code-health set when affected detection
  cannot prove the relevant package set.
- `ci:pack-dry-run`: run `pack-dry-run` for affected publishable packages.
- `ci:docs-contract`: run the docs-contract task.
- `ci:public-smoke`: run the public integration smoke task.

The standalone checks in this lane are:

- `node scripts/ci/repo-hygiene.mjs`
- `node scripts/ci/code-health.mjs --verify`
- `node scripts/ci/migration-inventories.mjs --check`
- `node scripts/ci/package-metadata.mjs`
- `node scripts/ci/pack-dry-run.mjs`
- `node scripts/security/security-compliance.mjs`

The workflow expects the root `package.json` to exist. Missing required root
scripts fail the lane.
