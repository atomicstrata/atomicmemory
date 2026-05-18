# Phase 4 Cutover Readiness

This page records the public-safe release preparation state for the monorepo
URL cutover. It intentionally excludes credentials, account operations, and
package-owner approval records.

## Staged public artifacts

- Package manifests point `repository`, `repository.directory`, `homepage`, and
  `bugs` metadata at `atomicstrata/atomicmemory`.
- Metadata-only package versions are staged in
  [`npm-metadata-publish-queue.json`](./npm-metadata-publish-queue.json).
- Host marketplace manifest status is staged in
  [`marketplace-cutover-audit.json`](./marketplace-cutover-audit.json).
- Release history and provenance are recorded in
  [`release-history.md`](./release-history.md).
- Public smoke coverage is recorded in
  [`../../tests/smoke/docs-contract/public-smoke-contract.json`](../../tests/smoke/docs-contract/public-smoke-contract.json).

## Pre-launch validation commands

Run the full release-required surface. Do not use affected filtering to narrow
the gate.

```bash
pnpm run repo-hygiene
pnpm run package-metadata
pnpm run security-compliance
pnpm run migration-inventories
pnpm run docs-contract
pnpm run public-integration-smoke
pnpm run pack-dry-run
pnpm run build
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run code-health
git diff --check
```

## Post-publish verification commands

After metadata-only package releases complete, verify registry metadata for
every published row in the publish queue.

```bash
npm view @atomicmemory/core version repository.url homepage bugs.url
npm view @atomicmemory/sdk version repository.url homepage bugs.url
npm view @atomicmemory/cli version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/mcp-server version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/vercel-ai version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/openai-agents version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/langchain version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/langgraph version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/mastra version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/claude-code-plugin version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/openclaw-plugin version repository.url repository.directory homepage bugs.url
npm view @atomicmemory/hermes-plugin version repository.url repository.directory homepage bugs.url
```

The expected repository URL is
`git+https://github.com/atomicstrata/atomicmemory.git`. Package-specific
homepage URLs should point at the package directory under the monorepo.
