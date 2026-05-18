# Release History And Provenance

This page records where each public AtomicMemory package lived before the
monorepo migration, what the last pre-migration version on each package was,
and where future releases live. It exists because the public monorepo is a
clean-history destination: git history is not preserved from the source repos,
so `git blame` and `git log <file>` stop at the migration boundary inside
`atomicstrata/atomicmemory`.

## Migration model

The monorepo at `atomicstrata/atomicmemory` is a new clean-history repository.
Each package was copied into its monorepo location as a flat source snapshot
at a specific source commit. The source commit, source repository, source
branch, and target path are recorded in
`docs/migration/source-snapshot-manifest.json`, and the file selection rules
for each copy are recorded in `docs/migration/allowlists/`.

Reasons for clean-history migration:

- The destination repo did not exist before migration.
- Old public repos had little accumulated star, issue, or external link
  gravity, so re-anchoring contributor activity on the monorepo is cheap now.
- Importing history would also import stale CI, retired branch names, and
  obsolete operational references; a clean source snapshot avoids that risk.
- Old repos are kept online as archives for historical lookup rather than
  being deleted.

Consequences contributors should expect:

- `git blame` inside the monorepo terminates at the initial monorepo commit
  for files copied from the source repos.
- `git log <file>` inside the monorepo only shows changes that landed in the
  monorepo. Pre-migration history lives in the archive repos.
- Pre-migration tags (for example `v1.0.3` in `atomicmemory-core`) remain in
  their original repositories. They are not re-created in the monorepo.
- New release tags use the monorepo per-package prefix convention defined in
  the implementation plan, for example `core-v1.0.4` and `sdk-v1.0.2`.

For deeper provenance questions, follow the archive link in the table below
or open an issue in the monorepo and ask for the relevant pre-migration
commit; the snapshot manifest records the exact source SHA used for each
package.

## Package history table

The pre-migration version column reflects the highest published version that
existed in the source repository at the snapshot commit recorded in
`docs/migration/source-snapshot-manifest.json`. The first monorepo tag
column shows the tag prefix that future per-package releases will use.

| Package | Pre-migration repo | Last pre-migration version | Monorepo path | First monorepo tag prefix | Older releases |
| --- | --- | --- | --- | --- | --- |
| `@atomicmemory/core` | `atomicstrata/atomicmemory-core` | 1.0.3 | `packages/core` | `core-v` | Search the archive repo at `atomicmemory-core-archive-<YYYY-MM>` after archival, or `atomicstrata/atomicmemory-core` before archival. |
| `@atomicmemory/sdk` | `atomicstrata/atomicmemory-sdk` | 1.0.1 | `packages/sdk` | `sdk-v` | Search the archive repo at `atomicmemory-sdk-archive-<YYYY-MM>` after archival, or `atomicstrata/atomicmemory-sdk` before archival. |
| `@atomicmemory/cli` | `atomicstrata/atomicmemory-integrations` | 0.1.1 | `packages/cli` | `cli-v` | Search `atomicstrata/atomicmemory-integrations` (subdirectory `packages/cli`) before archival; archive name `atomicmemory-integrations-archive-<YYYY-MM>` after. |
| `@atomicmemory/mcp-server` | `atomicstrata/atomicmemory-integrations` | 0.1.1 | `packages/mcp-server` | `mcp-server-v` | Search `atomicstrata/atomicmemory-integrations` (subdirectory `packages/mcp-server`) before archival; archive name `atomicmemory-integrations-archive-<YYYY-MM>` after. |
| `@atomicmemory/vercel-ai` | `atomicstrata/atomicmemory-integrations` | 0.1.0 | `adapters/vercel-ai` | `vercel-ai-v` | Source subdirectory was `adapters/vercel-ai-sdk` in the integrations repo; the monorepo renames it to `adapters/vercel-ai`. |
| `@atomicmemory/openai-agents` | `atomicstrata/atomicmemory-integrations` | 0.1.0 | `adapters/openai-agents` | `openai-agents-v` | Source subdirectory was `adapters/openai-agents-sdk` in the integrations repo; the monorepo renames it to `adapters/openai-agents`. |
| `@atomicmemory/langchain` | `atomicstrata/atomicmemory-integrations` (branch `feat/integration-maturity-framework-adapters`) | 0.1.0 | `adapters/langchain` | `langchain-v` | Source did not yet exist on integrations `main` at the manifest date. Source subdirectory was `adapters/langchain-js`; the monorepo renames it to `adapters/langchain`. |
| `@atomicmemory/langgraph` | `atomicstrata/atomicmemory-integrations` (branch `feat/integration-maturity-framework-adapters`) | 0.1.0 | `adapters/langgraph` | `langgraph-v` | Source did not yet exist on integrations `main` at the manifest date. Source subdirectory was `adapters/langgraph-js`; the monorepo renames it to `adapters/langgraph`. |
| `@atomicmemory/mastra` | `atomicstrata/atomicmemory-integrations` (branch `feat/integration-maturity-framework-adapters`) | 0.1.0 | `adapters/mastra` | `mastra-v` | Source did not yet exist on integrations `main` at the manifest date. Source subdirectory and monorepo path both `adapters/mastra`. |
| `@atomicmemory/claude-code-plugin` | `atomicstrata/atomicmemory-integrations` | 0.1.14 | `plugins/claude-code` | `claude-code-plugin-v` | Host plugins continue to share a lock-step version across releases. |
| `@atomicmemory/openclaw-plugin` | `atomicstrata/atomicmemory-integrations` | 0.1.14 | `plugins/openclaw` | `openclaw-plugin-v` | Host plugins continue to share a lock-step version across releases. |
| `@atomicmemory/hermes-plugin` | `atomicstrata/atomicmemory-integrations` | 0.1.14 | `plugins/hermes` | `hermes-plugin-v` | Plugin bundles the Hermes Python provider; the standalone Python SDK migration is a separate phase 2 decision. |
| `@atomicmemory/codex-plugin` | `atomicstrata/atomicmemory-integrations` | 0.1.14 | `plugins/codex` | `codex-plugin-v` (coming soon) | Public source is present, but no public npm package or host install path is supported until marketplace validation is complete. |
| `@atomicmemory/cursor-plugin` | `atomicstrata/atomicmemory-integrations` | 0.1.14 | `plugins/cursor` | `cursor-plugin-v` (coming soon) | Public source is present, but no public npm package or host install path is supported until marketplace validation is complete. |

## Tag policy in the monorepo

- Independent per-package tags for `core`, `sdk`, `cli`, `mcp-server`, and
  every adapter, using the prefixes above.
- Lock-step versioning is preserved across the host plugin set
  (`claude-code`, `openclaw`, `hermes`, `codex`, `cursor`). Any public
  plugin release in the lock-step set publishes a new version of every public
  plugin and tags each with the matching `<host>-plugin-v<version>` shape.
- The first post-migration release of each package starts at the next
  post-migration version of that package and is tagged in the monorepo.
- Pre-migration tags are not re-created in the monorepo; they remain in
  their original repositories and the corresponding archive after archival.

## Linking from package READMEs

Each package README inside the monorepo should link back to this page when a
contributor or user is likely to ask "what happened to history" or "where did
older releases live." Suggested text for package READMEs:

> This package previously lived in
> [`atomicstrata/<source-repo>`](https://github.com/atomicstrata/<source-repo>).
> For release notes published before the monorepo migration, see the source
> repository or its archive. For provenance details see
> [docs/migration/release-history.md](../../docs/migration/release-history.md).

The README quickstart should never instruct users to clone the source repo;
the canonical install path is the published package.
