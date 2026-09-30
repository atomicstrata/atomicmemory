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
- `am integrate` for global host MCP install into Cursor, Claude Code, Codex,
  and OpenCode (`list`, `detect`, `install`, `update`, `doctor`, `uninstall`). See
  [`crates/cli/README.md`](crates/cli/README.md).
- MCP `memory_ingest` reserved-metadata preflight and agent-facing schema
  guidance in `@atomicmemory/mcp-server` 0.1.5. See
  [`packages/mcp-server/CHANGELOG.md`](packages/mcp-server/CHANGELOG.md).
- Codex and OpenClaw plugin skills now direct agents to record lineage in
  `provenance` and reserve `metadata` for integration keys, matching the MCP
  guidance above (plugin packages 0.2.2).
- `am update` (CLI 0.4.0 and later) replaces a production `am` with the latest
  release from `get.atomicstrata.ai` after `SHA256SUMS` verification, with
  GitHub attestation when an authenticated `gh` is available (it warns when it
  falls back to checksum-only). Dev, internal, and canary builds refuse it. See
  [`crates/cli/README.md`](crates/cli/README.md).
- Hosted Streamable HTTP mode for `@atomicmemory/mcp-server` 0.1.6 with
  per-request project key auth. See
  [`packages/mcp-server/CHANGELOG.md`](packages/mcp-server/CHANGELOG.md) and
  [`packages/mcp-server/HOSTED.md`](packages/mcp-server/HOSTED.md).

### Fixed

- Tool family 0.1.6 makes the shared MCP configuration fail closed when
  AtomicMemory Cloud is selected without a project API key, and resolves the
  stdio default URL as explicit `ATOMICMEMORY_API_URL`, else Cloud when a key
  is set, else local Core (`http://127.0.0.1:17350`).
- Core OpenAI chat parameter selection and retry mitigations for reasoning and
  token-limit SKUs (no public API change). See
  [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md).
- `@atomicmemory/core` 1.2.2: harden `extractFacts` JSON parse against trailing
  prose after a successful completion (ATO-2185), and keep hosted migration
  compatibility in private deployment tooling. See
  [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md).

### Changed

- Plugin family 0.2.3 documents Cloud as the key-selected default for Claude
  Code, OpenClaw, and Hermes: an API key without a URL selects Cloud, while
  neither URL nor key falls back to local Core. Cloud credentials fail closed
  when Cloud is selected, and each host documents a no-local-process install
  path. The local Core key `local-dev-key` and plain `http://` are refused for
  Cloud hosts. Plugin manifests and the OpenClaw dependency pin
  `@atomicmemory/mcp-server@^0.1.6`. Publish `@atomicmemory/mcp-server@0.1.6`
  on npm before publishing the 0.2.3 plugins. `am integrate` still pins the
  last published `@atomicmemory/mcp-server@0.1.5` until that command's pin is
  bumped after the 0.1.6 publish.
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
