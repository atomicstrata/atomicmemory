# AGENTS.md

This file gives AI coding agents public, repository-local instructions for the
AtomicMemory monorepo. Keep it short, concrete, and safe for a public
repository. Human-facing project context lives in `README.md`, `CONTRIBUTING.md`,
`SECURITY.md`, and `ROADMAP.md`.

## Repository Shape

- `packages/` contains publishable libraries and runtimes: Core, SDK, CLI, and
  MCP server.
- `crates/` contains the CLI (`am`) and its Cloud API client/types.
  Rust is optional for contributors unless touching `crates/`.
- `adapters/` contains framework integrations.
- `plugins/` contains host integrations.
- `tests/smoke/` contains public smoke contracts and contributor-safe release
  checks.
- `examples/` is reserved for future examples that have owners and CI coverage.

## Working Rules

- Use `pnpm`; do not switch this repository to npm, yarn, or another package
  manager.
- Check `package.json` scripts before running manual build, test, lint, or
  release-validation commands.
- Keep release orchestration, sensitive operational runbooks, local machine
  paths, and secrets out of this repository.
- Keep adapters and plugins thin. Core memory behavior belongs in
  `packages/core` and SDK-facing behavior belongs in `packages/sdk`.
- Do not add examples unless they run from published packages or workspace
  packages and have CI coverage.
- Do not make performance claims without a linked benchmark, environment,
  dataset, and measurement date.

## Engineering Standards

- Keep changes small, direct, and scoped to the package, adapter, plugin, docs,
  or test surface being changed.
- Prefer existing local patterns and helpers over new abstractions.
- Use meaningful names that describe purpose.
- Keep functions focused on one responsibility.
- Avoid deep nesting; flatten control flow where it improves readability.
- Avoid magic numbers; use named constants for values with meaning.
- Do not catch errors silently. Either handle the error explicitly or let it
  propagate.
- No fallback modes. If something fails, fail closed with a clear error instead
  of running in a degraded or partially-supported mode.
- Add comments only when they explain non-obvious intent or constraints.
- Cross-cutting controls live at one chokepoint, enumerated and bypass-tested.
  When a security/correctness rule must hold for *all* of a category — every
  input reaching Postgres, every scoped MCP tool, every memory→model surface —
  apply it where those surfaces converge (the query layer, one scope gate, one
  shared sanitizer/validator), not replicated per surface. If it must be
  replicated, add an enumeration test that fails when a new surface lacks it.
  Tests must exercise the adversarial bypass (the encoding, the object key, the
  header, the interleaving, the second language) — not just the canonical
  example — and validate against the downstream consumer's interpretation (the
  resolver, Postgres, the model's tag parser), not your own parser. Per-surface
  defense is leaky by construction: one sibling always gets missed.

The standards above are language-neutral. Sizing and idiom rules are not: they
live in the per-language sections below. Follow the section matching the
directory you are editing.

### Size Limits (TypeScript And JavaScript)

These limits are acceptance criteria for code review in `packages/`,
`adapters/`, `plugins/`, `tests/`, and root scripts. They do not apply to
`crates/`, which uses the responsibility-based rule in
[Rust Standards](#rust-standards-crates).

- Code files must stay under 400 lines, excluding comments.
- Test files must stay under 400 lines, excluding comments.
- Functions must stay under 40 lines, excluding comments and catch/finally
  blocks.
- Individual tests must stay under 40 lines, excluding comments and
  catch/finally blocks.
- Markdown and other prose/config files (`.md`, `.mdx`, `.yaml`, `.json`,
  `.toml`) are exempt from the 400-line document limit.

If a change would exceed these limits, refactor into smaller modules, helpers,
or focused tests before opening the PR.

### TypeScript Standards

- Use TypeScript or `.mjs` files for new JavaScript-facing code.
- Define explicit types for public APIs and exported helpers.
- Avoid `any`; use `unknown`, generics, or concrete interfaces instead.
- Keep package boundaries clean. Core memory behavior belongs in
  `packages/core`; SDK-facing behavior belongs in `packages/sdk`; adapters and
  plugins should remain thin.
- Use package-local configuration helpers when they exist. Do not scatter direct
  environment-variable reads through feature code.
- Prefer deterministic control flow and explicit errors over implicit defaults.

### Rust Standards (`crates/`)

Rust follows the language-neutral standards above. It deliberately does **not**
inherit the TypeScript line limits: derives, trait and `impl` blocks, exhaustive
`match` arms, and colocated `#[cfg(test)]` modules make a raw line count a poor
proxy for complexity. A long command module whose functions each do one thing is
idiomatic Rust; a short module with deep nesting and implicit control flow is
not.

- Prefer shallow control flow and small functions. If a function becomes hard to
  scan, split it by responsibility — not to reach a number.
- Split a module when it carries unrelated responsibilities, or when adding a
  feature means reading code in the same file that has nothing to do with it.
- Colocated `#[cfg(test)]` modules are expected and do not count toward module
  size.
- Edition **2024**, `rust-version = 1.88` in the root `Cargo.toml`;
  `rust-toolchain.toml` pins the exact toolchain CI uses. Raise the MSRV
  deliberately, and only together with the `msrv-check` job.
- Prefer explicit types, typed errors (`thiserror`), and clear ownership
  boundaries. No `unwrap()` / `expect()` outside `#[cfg(test)]`.
- Fail closed — no degraded fallback modes. Never log secrets or PII through
  `tracing`; redact before a value can reach a log or a user-visible error.
- Load configuration at process boundaries; do not read environment variables
  deep inside library crates.
- Keep dependencies conservative. Do not add a crate for a small utility.
- Replace magic numbers with named constants, especially timeouts, retry
  budgets, and other bounds.
- Comment why a non-obvious choice exists. Do not comment obvious mechanics.
- Validation for Rust changes (mirrors the `ci-rust` workflow):

```bash
pnpm run ci:rust
```

That script runs `cargo fmt --all -- --check`, `cargo clippy --workspace
--all-targets --all-features --locked -- -D warnings`, `cargo test --workspace
--locked`, and a release `am --help` smoke. CI additionally runs an MSRV
`cargo check`, `cargo-deny`, and the suite on macOS and Windows. While
iterating, prefer targeted checks such as `cargo test -p atomicmemory`.

### Comments And Documentation

- Start every code file with a comment explaining the file's purpose: JSDoc in
  TypeScript and JavaScript, a `//!` module doc in Rust.
- Document public APIs, exported functions, classes, and public types. In Rust
  that means `///` doc comments on public items.
- Write clear comments for complex logic, non-obvious constraints, or security
  boundaries.
- Keep comments up to date with code changes.
- Avoid comments that restate obvious code behavior.

### Test Standards

- Tests must be deterministic. Do not use timing-based fixes or sleeps to hide
  races.
- Test real code paths where practical. Avoid mocks that bypass the behavior
  under review.
- Follow patterns from existing successful tests in the same package.
- Keep fixtures small and explain why unusual data is needed.
- When changing public behavior, cover the package API or contract surface that
  users actually call.

### Documentation Standards

- Treat docs as part of the product surface. Install commands, package names,
  status labels, and examples must match the current public package matrix and
  smoke contract.
- Preserve the no-clone happy path for public users. Do not make cloning this
  repository a requirement unless the section is explicitly about contributing
  or local development.
- Keep docs public-safe. Do not include non-public repo names, sensitive
  operational process, local machine paths, or secrets.
- Do not publish performance, reliability, or compatibility claims without
  reproducible evidence or a clearly marked status.
- Keep quickstarts short. Put optional lifecycle, troubleshooting, or advanced
  commands in separate sections.
- When changing docs that mention install commands, package status, smoke rows,
  or release readiness, run the relevant docs-contract and smoke checks.
- Do not lint markdown files or make broad formatting-only markdown churn unless
  the task explicitly asks for it.

## Common Commands

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

Release and public-contract checks:

```bash
pnpm run package-metadata
pnpm run repo-hygiene
pnpm run security-compliance
pnpm run docs-contract
pnpm run public-integration-smoke
pnpm run pack-dry-run
```

CI aliases:

```bash
pnpm run ci:affected
pnpm run ci:pack-dry-run
pnpm run ci:docs-contract
pnpm run ci:public-smoke
```

`ci:affected` builds, typechecks, and lints affected packages, then runs tests
for self-contained packages. DB-backed Core tests require service provisioning
and are intentionally outside the generic affected lane.

## Validation Expectations

- For package or source changes, run the nearest package scripts plus the root
  affected or release-contract checks that match the change.
- For docs-only changes, run `git diff --check` and any relevant contract
  checks when the docs mention package commands, install paths, or smoke rows.
- For package metadata, CI, security, or smoke-contract changes, run the root
  validation scripts listed above.
- Do not treat a cached Turbo result as proof that a side-effecting release
  check passed; `pack-dry-run`, smoke, hygiene, and security checks are
  intentionally non-cacheable or run through direct root scripts.
- Before marking work ready for review, run `git diff --check`.
- For publishable package metadata, exports, files, or dependency changes, run
  `pnpm run pack-dry-run` and `pnpm run package-metadata`.
- For public-boundary, workflow, security, or policy changes, run
  `pnpm run repo-hygiene` and `pnpm run security-compliance`.

## Pull Request Notes

- Keep changes scoped to the relevant package, adapter, plugin, docs, or test
  surface.
- Update package matrix or smoke-contract rows when support status changes.
- Do not include sensitive release sequencing or operational instructions in PR
  descriptions, docs, or examples.
