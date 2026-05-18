# Public CI Skeleton

This directory contains public-safe checks that can run before package source is
copied into the monorepo.

## Required Root Scripts

When the root `package.json` and `turbo.json` land, the workflow expects these
root scripts to exist and to call `turbo run`:

- `ci:affected`: build, typecheck, test, and lint affected packages plus
  dependents.
- `ci:pack-dry-run`: run `pack-dry-run` for affected publishable packages.
- `ci:docs-contract`: run the docs-contract task.
- `ci:public-smoke`: run the public integration smoke task.

The standalone checks in this lane are:

- `node scripts/ci/repo-hygiene.mjs`
- `node scripts/ci/package-metadata.mjs`
- `node scripts/ci/pack-dry-run.mjs`
- `node scripts/security/security-compliance.mjs`

The workflow skips turbo-dependent lanes only while the root `package.json` is
absent. Once it exists, missing required root scripts fail the lane.
