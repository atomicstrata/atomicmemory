# AGENTS.md

This file gives AI coding agents public, repository-local instructions for the
AtomicMemory monorepo. Keep it short, concrete, and safe for a public
repository. Human-facing project context lives in `README.md`, `CONTRIBUTING.md`,
`SECURITY.md`, and `ROADMAP.md`.

## Repository Shape

- `packages/` contains publishable libraries and runtimes: Core, SDK, CLI, and
  MCP server.
- `adapters/` contains framework integrations.
- `plugins/` contains host integrations.
- `tests/smoke/` contains public smoke contracts and contributor-safe release
  checks.
- `docs/` contains public docs and migration provenance material.
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

### Size Limits

These limits are acceptance criteria for code review:

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

### Comments And Documentation

- Include a JSDoc comment at the top of each code file that explains the file's
  purpose.
- Document public APIs, exported functions, classes, and public types.
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
