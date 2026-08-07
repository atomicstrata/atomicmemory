# AtomicMemory CLI (`am`)

First-party CLI for **AtomicMemory Cloud** — browser login, org/project/API-key
management, Connected Local linking, and memory operations.

Phase 2 ships prebuilt **`am`** binaries. End users install with one command;
contributors can still build from source.

```bash
curl -fsSL https://get.atomicstrata.ai/install.sh | sh
. "$HOME/.atomicmemory/env"   # activate PATH in this shell (new terminals: not needed)
am --help
```

Canonical artifacts live on [GitHub Releases](https://github.com/atomicstrata/atomicmemory/releases)
(checksums + build provenance). The domain above is a mirrored convenience
channel with the same digests; verify either against `SHA256SUMS` as shown
below.

Contributors (from source):

```bash
cargo install --path crates/cli --force
am --help
```

This is the **CLI** (`am`): auth, org/project/key, connect, instance,
memory, migrate, doctor, integrate (MCP), and lifecycle hooks.

Consolidation of the npm `@atomicmemory/cli` package into `am` is **in
progress**: `am` covers Cloud, memory, MCP integration, and lifecycle hooks,
while `atomicmemory` remains published for `import --type llmwiki` and legacy
workflows. Maintainer-only npm surfaces (`validate`, Ink TUI, experimental
stubs) are not ported.

## Verify your download

```bash
ver=0.2.0
target=aarch64-apple-darwin
base="https://github.com/atomicstrata/atomicmemory/releases/download/cli-v${ver}"
curl -fsSLO "${base}/am-${ver}-${target}.tar.gz"
curl -fsSL  "${base}/SHA256SUMS" | shasum -a 256 -c --ignore-missing
```

With GitHub CLI:

```bash
gh attestation verify "./am-${ver}-${target}.tar.gz" \
  --repo atomicstrata/atomicmemory \
  --signer-workflow atomicstrata/atomicmemory/.github/workflows/release-cli.yml \
  --source-ref "refs/tags/cli-v${ver}"
```

## Quick start

```bash
am init
am memory ingest "I prefer aisle seats when flying."
```

`am init` runs browser login (OAuth), bootstraps a personal workspace when
needed, links a local profile, and can start Core in Docker. Skip Core with
`am init --no-instance`.

For a Connected Local project already created in the dashboard:

```bash
am init --project <project-slug>
```

### Manual steps (equivalent)

```bash
am auth login
am link local --name local --local-url http://127.0.0.1:17350
am instance start
```

`am instance start` auto-provisions a Cloud `amc_` key when needed and injects a
local `CORE_API_KEY` into the managed container (reused from the state volume on
later starts). Local `am memory *` / smoke prefer that persisted Core key over a
Cloud-minted JWT.

Cloud key policy for Connected Local: the CLI treats `connected-local-runtime` as
a **singleton per project**. If a working key is already stored locally it is
reused; otherwise an existing active key with that name is **rotated** (obvious
stderr message) instead of creating another and burning API-key quota. Create
only runs when no such key exists. Rotating that key invalidates the previous
secret on every machine that shared it — prefer one operator machine, or re-run
`am init` / `am connect --project` on other machines after a rotate.

### Token fallback

Paste a dashboard session JWT when browser OAuth is unavailable:

```bash
am auth login --token "eyJ..."
```

## Defaults

| Setting | Default |
|---------|---------|
| API URL | `https://api.atomicstrata.ai` |
| Core image | `ghcr.io/atomicstrata/atomicmemory-core:latest` |
| OAuth issuer | `https://clerk.atomicstrata.ai` |

The public binary is **production-only**. Override the API URL with
`--base-url`, a profile `base_url`, or `ATOMICMEMORY_API_URL`. For
non-production Cloud URLs you must also supply OAuth credentials (flags,
profile, or env) — the CLI will not silently use production OAuth against a
custom host.

## Non-production Cloud (contributors / internal)

Use a local profile on your machine (not committed to git):

```toml
[profiles.staging]
base_url = "https://api.staging.example.com"
kind = "cloud"

[oauth]
issuer = "https://your-clerk-issuer.example.com"
client_id = "your_oauth_client_id"
```

```bash
am --profile staging auth login
```

Or pass flags explicitly:

```bash
am --base-url https://api.staging.example.com \
  auth login --issuer https://your-clerk-issuer.example.com \
  --client-id your_oauth_client_id
```

## Command groups

| Group | Purpose |
|-------|---------|
| `init`, `auth`, `config` | First-run setup, login, profiles |
| `org`, `project`, `key` | Cloud control plane |
| `memory` | Ingest (`--mode text\|messages\|verbatim`), search, **package**, list, get, delete |
| `hooks` | Lifecycle hooks for Codex and Claude Code (complements `integrate` MCP) |
| `connect`, `instance`, `link` | Connected Local + Docker Core |
| `integrate` | Install AtomicMemory MCP into Cursor, Claude Code, and Codex |
| `trace`, `usage`, `overview` | Observability |
| `migrate` | Export/import local Core memories |
| `doctor`, `health` | Diagnostics |

Run `am <command> --help` for flags.

### Host MCP integration

After `am init` or Connected Local setup, wire AtomicMemory into agent hosts
(global user config only in v1):

```bash
am integrate detect
am integrate --yes --global --host cursor --host claude-code
am integrate doctor
am integrate uninstall --host cursor
```

Installs set `ATOMICMEMORY_SCOPE_LOCK=true` in the generated MCP server env and
pin `@atomicmemory/mcp-server@0.1.5`. Project-scoped configs (for example
`.cursor/mcp.json` in a repo) are not supported yet — use global install only.
`--dry-run` prints planned writes without mutating host files. In non-interactive
sessions, pass `--yes` and/or explicit `--host` before mutating configs.
Interactive wizard progress and next-step hints go to stderr; human install
summaries (and `-o json` reports) go to stdout.

### Lifecycle hooks (Codex / Claude Code)

`am integrate` installs MCP tools. `am hooks` installs **lifecycle** automation
(prompt context injection, compact/stop verbatim ingest) without a tool call:

```bash
am hooks install --host codex
am hooks install --host claude-code
am hooks doctor --host codex
am hooks run user-prompt-submit --host codex   # invoked by host config
```

Pick **either** the Claude Code plugin shell hooks (rich path) **or** `am hooks`
(three-event alternate) — not both on the same events.

### Memory package and agent output

```bash
am memory ingest "I prefer aisle seats" --mode text
am memory package "recent implementation context" --token-budget 1200
am --agent memory search "release policy" --limit 5
```

Global scope flags: `--scope-user`, `--scope-agent-id`, `--scope-namespace`,
`--scope-thread` (or matching `ATOMICMEMORY_SCOPE_*` env vars).

## Configuration

Config and credentials live under the OS application support directory
(macOS: `~/Library/Application Support/ai.atomicstrata.atomicmemory/`).

Common environment variables:

| Variable | Purpose |
|----------|---------|
| `ATOMICMEMORY_PROFILE` | Active profile name |
| `ATOMICMEMORY_API_URL` | Cloud API base URL |
| `ATOMICMEMORY_API_KEY` | Override stored `amc_…` key |
| `ATOMICMEMORY_OAUTH_ISSUER` | OAuth issuer for custom Cloud URL |
| `ATOMICMEMORY_OAUTH_CLIENT_ID` | OAuth client ID for custom Cloud URL |
| `ATOMICMEMORY_CORE_IMAGE` | Core Docker image override |
| `OPENAI_API_KEY` | Required for `am instance start` |
| `AM_TELEMETRY=0` | Disable anonymous activation telemetry |
| `RUST_LOG` | Log filter, e.g. `RUST_LOG=debug` or `RUST_LOG=am_cloud_client=debug` |

Telemetry sends activation funnel events only when enabled; no API keys or
session tokens are included. Opt out with `--no-telemetry` or `AM_TELEMETRY=0`.

## Output

Structured commands honor `--output table|json` (both currently emit JSON on
stdout; human status text goes to stderr). A few commands are raw by design and
ignore `--output`: `am connect env` (shell-export blocks), `am instance logs`
(container log stream), and `am auth token` / `am connect token --print-token`
(the bare token, for piping).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Authentication / authorization |
| 3 | Network / timeout |
| 4 | Cloud HTTP error response |

## Logging

Logs go to stderr, so they never mix into piped `--output json` results.
`-v` raises the level to info, `-vv` to debug, `-vvv` to trace. `RUST_LOG`
overrides the flag when you need per-target filters:

```bash
am -vv instance start
RUST_LOG=am_cloud_client=debug am project list
```

## Diagnostics

```bash
am auth doctor
am doctor
am connect doctor
```

## License

Apache-2.0 — see the repository root `LICENSE`.
