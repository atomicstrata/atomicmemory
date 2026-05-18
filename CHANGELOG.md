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

- Initial clean-history public monorepo foundation.
- Public package matrix, README, contributing guide, security policy, roadmap,
  and code of conduct.
- Public smoke contract package under `tests/smoke`.
- CI lanes for package metadata, repo hygiene, affected build/test validation,
  package dry-runs, docs contract validation, public smoke checks, and security
  compliance.
- Source snapshot provenance manifests for packages, adapters, plugins, and
  public validation assets.

### Notes

- Package publishes, old-repo redirects, and marketplace resubmissions are
  tracked as separate release operations.
