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

### CLI fresh-install smoke

Installs the published `am` from the internal channel onto a machine that has
never had it, and proves the result works — the artifact-level counterpart to
`core-docker-smoke`. Needs an authenticated `gh` with access to
`atomicstrata/atomicmemory-internal`; nothing else.

```bash
gh auth login                 # once
pnpm run smoke:cli-install
AM_INTERNAL_TAG=cli-internal-<sha> pnpm run smoke:cli-install   # pin a build
AM_INTERNAL_TAG=cli-canary-latest pnpm run smoke:cli-install    # floating canary (dev)
AM_SMOKE_KEEP=1 pnpm run smoke:cli-install                      # keep the sandbox to inspect
```

Install canary without the smoke harness:

```bash
tmp="$(mktemp -d)" && \
AM_INTERNAL_TAG=cli-canary-latest gh release download cli-canary-latest \
  --repo atomicstrata/atomicmemory-internal \
  --pattern install.sh \
  --dir "$tmp" \
  && AM_INTERNAL_TAG=cli-canary-latest sh "$tmp/install.sh"
```

`$HOME` and the install directory are throwaway, so it will not disturb an `am`
you already have installed — and it cannot be fooled by one either, because
every check addresses the newly installed binary by absolute path. `PATH` is
deliberately left as it is: the one check that does consult it, that sourcing
`~/.atomicmemory/env` makes the new install win, is a stronger check when a
competing `am` is present.
`scripts/cli-install-smoke.sh` documents what each check catches and why the
existing fixture tests do not cover it. It also runs daily in CI, one job per
published target — see `.github/workflows/cli-install-smoke.yml`. A scheduled
failure opens one self-clearing issue labelled `cli-install-smoke`; a manual
dispatch never touches it.

CI uses thin `ci:*` aliases that wrap the same Turbo tasks:

```bash
pnpm run ci:affected         # build / typecheck / lint for affected packages; tests for self-contained packages
pnpm run ci:code-health      # fallow/code-health coverage
pnpm run ci:pack-dry-run     # pack-dry-run, affected-only
pnpm run ci:docs-contract    # docs-contract
pnpm run ci:public-smoke     # public-integration-smoke
pnpm run ci:rust             # fmt, clippy, test, release build, am --help (when crates/ changes)
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
  `chore/...`).
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
- `ci-rust` (path-filtered) — MSRV `cargo check`, pinned-toolchain `cargo fmt`,
  `clippy -D warnings`, and `cargo test` when `crates/` or root Cargo files change.

Full release validation runs every required package and smoke row on release
branches; affected filtering does not narrow that surface.

### Rust contributors

Install Rust via `rust-toolchain.toml` (1.88.0 + rustfmt + clippy). When
changing `crates/`:

```bash
pnpm run ci:rust
```

The user-facing CLI is **`am`** (Rust, `crates/cli`). Consolidation of the npm
`atomicmemory` binary into `am` is in progress — see
[`crates/cli/README.md`](crates/cli/README.md) for the `atomicmemory` to `am`
command map. Until the npm package is archived, both binaries may coexist;
prefer `am` for new docs and host snippets.

For non-production Cloud tiers, use a local profile or `--base-url` with
explicit OAuth issuer/client — production OAuth is not applied to custom URLs.
See [`crates/cli/README.md`](crates/cli/README.md) for install,
`am integrate`, and distribution details.

Docs PRs that change install commands or package status labels should run
`git diff --check` and `pnpm run docs-contract` before opening a review.

PRs need CODEOWNERS approval for the touched paths and all required checks
must be green before merge.

## What lives where

| Tree | Contents |
| --- | --- |
| `packages/` | Publishable libraries and runtimes with semver discipline. |
| `adapters/` | Framework integrations. Directory names match the unscoped npm package name. |
| `plugins/` | Host integrations. Directory uses the bare host name; package uses the `-plugin` suffix. |
| `crates/` | CLI and Cloud/Core wire types. Requires `rustc` when changed. |
| `examples/` | Reserved for phase 2+. Only land examples with owners and CI coverage. |
| `tests/smoke/` | Public, contributor-safe smoke tests and docs contracts. |

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
