# Source Snapshot Allowlists

Each file in this directory defines what is allowed into the public monorepo
from one source-to-target copy listed in
`docs/migration/source-snapshot-manifest.json`. The allowlist is the
authoritative answer to the question "why is every copied file in the public
repo." Post-copy cleanup is a verification step, not the security control.

## Allowlist contract

Every allowlist must include:

- `id` — matches the entry `id` in `source-snapshot-manifest.json`.
- `source_repo`, `source_ref`, `source_commit` — match the manifest entry.
- `source_subpath` — required when copying from a subdirectory.
- `target_path` — where the snapshot lands in the public monorepo.
- `included_paths` — glob patterns, relative to `source_subpath` when set or
  to the repo root otherwise. Order does not matter; matches are unioned.
- `excluded_paths` — glob patterns subtracted from `included_paths`.
  Excludes always win over includes.
- `owner` — accountable owner placeholder. Replace before the copy executes.
- `reviewer` — public-safety reviewer placeholder. Must differ from `owner`.
  Replace before the copy executes.
- `notes` — anything the reviewer needs to understand the boundary.

The default posture is deny by default. Anything not matched by an
`included_paths` glob does not get copied even if it lives in the source tree.

## Default global exclusions

The following are excluded by default for every copy and do not need to be
repeated in each allowlist unless a specific exception is requested:

- `**/.git/**`, `**/.github/**` (workflows are re-created at the monorepo
  root by the workflows lane)
- `**/node_modules/**`
- `**/dist/**`, `**/build/**`, `**/coverage/**`, `**/.nyc_output/**`
- `**/.tsbuildinfo`, `**/*.tsbuildinfo`
- `**/.cache/**`, `**/.fallow/**`, `**/.husky/**`
- `**/.venv/**`, `**/__pycache__/**`, `**/*.pyc`, `**/*.pyo`,
  `**/.hypothesis/**`
- `**/.vscode/**`, `**/.idea/**`, `**/*.swp`, `**/*.swo`
- `**/.DS_Store`, `**/Thumbs.db`
- `**/.env`, `**/.env.*` (sanitized `.env*.example` may be re-included by
  the per-source allowlist if the package needs one)
- `**/.npmrc`, `**/.npmrc.local`
- `**/.mcp.json`
- `**/.traces/**`, `**/.agents/**`
- `**/AGENTS.md`, `**/GEMINI.md`, `**/CLAUDE.md` (source-repo AI assistant
  guidance; replaced at the monorepo root by public CONTRIBUTING.md)
- `**/tech-debt.md` (source-repo maintenance notes)
- `**/pnpm-lock.yaml`, `**/package-lock.json` (lockfiles are re-generated
  at the monorepo workspace root)

A per-source allowlist may opt back into a default-excluded file by listing
the exact path in `included_paths` and adding a `notes` justification.

## Workflow

1. Open the allowlist, fill in `owner` and `reviewer`, and review every
   include/exclude against the current source tree at `source_commit`.
2. Run the copy command using the allowlist as
   the file selector.
3. Emit a file inventory next to the snapshot manifest using the
   `docs/migration/file-inventory-template.json` shape. Hashes must be
   computed from the actually copied files; never invent.
4. Open a PR that includes the snapshot, the populated allowlist, and the
   inventory. The reviewer signs off only if every copied file is matched
   by an `included_paths` entry and no excluded file leaked through.
