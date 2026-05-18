# Contributing to AtomicMemory

Thank you for considering a contribution. This document covers the workflow,
expectations, and gating checks for changes to this repository.

## Before you start

- Read the [`README.md`](README.md) for the product positioning and package
  matrix. Make sure your change is consistent with the public claims there.
- Read [`SECURITY.md`](SECURITY.md) before reporting security issues. **Do
  not file a public issue for vulnerabilities.**
- AI coding agents should read [`AGENTS.md`](AGENTS.md). `CLAUDE.md` and
  `GEMINI.md` point their respective CLIs at the same public instructions.
- If your change is non-trivial (new public API, new package, behavior change
  in an adapter or host plugin), open a discussion issue first so we can align
  on the design before code review.

## Development workflow

We use pnpm workspaces and Turborepo. Node 20.10+ and pnpm 9.15+ are required;
both are pinned in the root `package.json`.

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test       # self-contained packages
pnpm run test:core  # requires core test services
pnpm run lint
```

Local-only side-effecting gates:

```bash
pnpm run pack-dry-run
pnpm run package-metadata
pnpm run docs-contract
pnpm run public-integration-smoke
pnpm run repo-hygiene
pnpm run security-compliance
```

These checks always read current repository state. Some are explicit
`cache: false` Turbo tasks; others are direct root scripts that bypass Turbo's
cache.

CI uses thin `ci:*` aliases that wrap the same Turbo tasks:

```bash
pnpm run ci:affected         # build / typecheck / lint for affected packages; tests for self-contained packages
pnpm run ci:code-health      # fallow/code-health coverage
pnpm run ci:pack-dry-run     # pack-dry-run, affected-only
pnpm run ci:docs-contract    # docs-contract
pnpm run ci:public-smoke     # public-integration-smoke
```

The `--affected` filter is only used on normal PR lanes. Release-green
validation runs the unprefixed scripts so the required-row surface is never
narrowed by affected detection. `@atomicmemory/core` has DB-backed tests that
require service provisioning; the generic affected lane still builds,
typechecks, lints, packs, and validates metadata for core changes.

Per-package commands work via `pnpm --filter <name> run <task>` once a package
lands in `packages/`, `adapters/`, or `plugins/`. Each package owns its own
`package.json` scripts; Turbo's job is to order and parallelize them.

## Branching and commits

- Default branch: `main`. Direct pushes to `main` are not permitted.
- Branch from `main` using a descriptive name (`feat/...`, `fix/...`,
  `docs/...`, `chore/...`).
- Keep commits small and focused. Use Conventional Commits style messages when
  practical (`feat(sdk): ...`, `fix(adapters/langchain): ...`).
- Sign your commits where you can. Branch protection may require verified
  signatures on protected branches.

## Pull request expectations

Every pull request runs through:

- `repo-hygiene` — no sensitive references, no `file:` / `link:` deps in
  publishable packages, no leaked non-public hostnames.
- `package-metadata` — `repository`, `homepage`, `bugs`, `license`, `exports`,
  `bin`, and `files` are valid for every publishable package.
- `affected-build-test` — build, typecheck, and lint for packages affected by
  the diff, plus tests for self-contained packages and their dependents.
- `pack-dry-run` — `npm pack --dry-run --json` for changed publishable
  packages.
- `docs-contract` — docs commands match harness and package commands.
- `public-integration-smoke` — package-protocol smoke checks that run without
  sensitive services or secrets.
- `security-compliance` — secret scan, dependency review, license policy,
  GitHub Actions policy, and public-boundary checks.
- `code-health` — fallow and package-level code-health coverage for packages
  that carry that gate.

Full release validation runs every required package and smoke row on release
branches; affected filtering does not narrow that surface.

PRs need CODEOWNERS approval for the touched paths and all required checks
must be green before merge.

## What lives where

| Tree | Contents |
| --- | --- |
| `packages/` | Publishable libraries and runtimes with semver discipline. |
| `adapters/` | Framework integrations. Directory names match the unscoped npm package name. |
| `plugins/` | Host integrations. Directory uses the bare host name; package uses the `-plugin` suffix. |
| `examples/` | Reserved for phase 2+. Only land examples with owners and CI coverage. |
| `tests/smoke/` | Public, contributor-safe smoke tests and docs contracts. |
| `docs/` | Public docs surface that ships from this repository. |

Release orchestration, marketplace operations, sensitive service configuration,
and any path under `/Users/...` are out of scope for this repository. If a
change requires credentials or production access, it belongs outside this repo.

## Reporting bugs

Open an issue with:

- which package, adapter, or plugin is affected;
- a minimal reproduction (preferably from a published version);
- expected vs. actual behavior;
- environment details (Node version, OS, host app version when relevant).

For host-plugin issues, please also note the host application version, since
plugin compatibility tracks the host's manifest format.

## Code of conduct

Be respectful, assume good intent, and disagree on substance. We do not
tolerate harassment or personal attacks. Project maintainers may remove
comments, commits, code, issues, or pull requests that conflict with this
expectation.
