# Changelog

This file records repository-level changes for the AtomicMemory public
monorepo. Package-specific API and release notes live with each package:

- `packages/core/CHANGELOG.md`
- `packages/sdk/CHANGELOG.md`
- `packages/cli/CHANGELOG.md`
- `packages/mcp-server/CHANGELOG.md`
- adapter and plugin changelogs when those packages add package-specific release
  notes

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and package versions follow semver unless a package is intentionally unpublished
or publish pending.

## Unreleased

### Added

- Consolidation of `@atomicmemory/cli` into `am`: memory package, SDK ingest
  modes, agent output envelope, lifecycle hooks, and relocations. The
  `atomicmemory` to `am` command map lives in
  [`crates/cli/README.md`](crates/cli/README.md).
- `am memory package`, SDK-aligned `am memory ingest --mode`, global `--agent`
  output envelope, and `am hooks` (install / run / doctor / uninstall) for Codex
  and Claude Code.
- Maintainer `pnpm run validate:cli` for the relocated npm `validate` surface.
- Initial clean-history public monorepo foundation.
- Public package matrix, README, contributing guide, security policy, roadmap,
  and code of conduct.
- Public smoke contract package under `tests/smoke`.
- CI lanes for package metadata, repo hygiene, affected build/test validation,
  package dry-runs, docs contract validation, public smoke checks, and security
  compliance.
- Source snapshot provenance manifests for packages, adapters, plugins, and
  public validation assets.
- Metadata-only cutover versions for published packages so npm registry
  metadata can point at the monorepo.
- CLI (`am`) public install channel via GitHub Releases and
  `get.atomicstrata.ai`, with install and verification steps in
  [`crates/cli/README.md`](crates/cli/README.md).
- `am integrate` for global host MCP install into Cursor, Claude Code, and
  Codex (`list`, `detect`, `install`, `update`, `doctor`, `uninstall`). See
  [`crates/cli/README.md`](crates/cli/README.md).
- MCP `memory_ingest` reserved-metadata preflight and agent-facing schema
  guidance in `@atomicmemory/mcp-server` 0.1.5. See
  [`packages/mcp-server/CHANGELOG.md`](packages/mcp-server/CHANGELOG.md).
- Codex and OpenClaw plugin skills now direct agents to record lineage in
  `provenance` and reserve `metadata` for integration keys, matching the MCP
  guidance above (plugin packages 0.2.2).

### Fixed

- Core OpenAI chat parameter selection and retry mitigations for reasoning and
  token-limit SKUs (no public API change). See
  [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md).

### Changed

- `@atomicmemory/cli` (`atomicmemory`) is **deprecated** in favor of `am`; see
  consolidation doc for command mapping and smoke-contract updates. It stays
  published and supported for `import --type llmwiki` (not yet ported to `am`
  or the SDK) and legacy workflows. The deprecation is surfaced in `atomicmemory
  help`, this changelog, the package README, and the public smoke contract —
  deliberately not as a runtime stderr banner, which would violate the CLI's
  output contracts (`--output quiet` must emit nothing, `--agent`/`--json` must
  keep stderr clean, and only `src/renderers/*` may write to the streams).

### Notes

- Internal eng-team prebuilds (`cli-internal-*`) are a contributor channel and
  not a public product install path. Public installs use GitHub Releases or the
  `get.atomicstrata.ai` mirror.
- Package publishes, old-repo redirects, and marketplace resubmissions are
  tracked as separate release operations.
