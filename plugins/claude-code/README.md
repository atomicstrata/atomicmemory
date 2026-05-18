# AtomicMemory for Claude Code

Persistent semantic memory that survives across Claude Code sessions. Ships the MCP server spec, lifecycle hooks for automatic memory capture, and a skill that teaches Claude when to call the memory tools.

## Install

### 1. Install dependencies

The hook scripts are bash and depend on `jq` (for safe JSON input/output parsing) and `curl` (for `on_user_prompt.sh`'s direct HTTP search).

```bash
# macOS
brew install jq

# Debian/Ubuntu
sudo apt-get install -y jq
```

### 2. Configure (optional in local mode)

The MCP server and the lifecycle hook scripts read their config from the shell environment. None of the `ATOMICMEMORY_*` variables are required to run the plugin against a local AtomicMemory core — the documented defaults are:

| Var | Local-mode default |
|---|---|
| `ATOMICMEMORY_API_URL` | `http://127.0.0.1:3050` |
| `ATOMICMEMORY_API_KEY` | not required |
| `ATOMICMEMORY_PROVIDER` | `atomicmemory` |
| `ATOMICMEMORY_SCOPE_USER` | derived from the host OS user |
| `ATOMICMEMORY_CAPTURE_LEVEL` | `balanced` |

Set them only when you need to override a default (for example, to talk to a hosted AtomicMemory service):

```bash
export ATOMICMEMORY_API_URL="https://memory.yourco.com"
export ATOMICMEMORY_API_KEY="am_live_…"
export ATOMICMEMORY_SCOPE_USER="$USER"
export ATOMICMEMORY_CAPTURE_LEVEL="balanced" # minimal|balanced|full
# Optional scope:
# export ATOMICMEMORY_SCOPE_NAMESPACE="<repo-or-project>"
# export ATOMICMEMORY_SCOPE_AGENT="claude-code"
# export ATOMICMEMORY_SCOPE_THREAD="<thread-id>"
```

Set `ATOMICMEMORY_SCOPE_USER` explicitly when multiple operators share a machine or when you need a stable cross-machine identity; otherwise the MCP server derives one from the host OS.

#### Local extraction with Claude Code auth

For personal/local use, AtomicMemory core can use Claude Code's own local auth
for semantic extraction instead of an Anthropic API key:

```bash
claude auth login
export LLM_PROVIDER="claude-code"
# Optional model override; omit to use Claude Code's configured default.
# export LLM_MODEL="sonnet"
```

This setting belongs to the AtomicMemory core process, not the Claude Code hook
environment. The plugin still needs the `ATOMICMEMORY_*` variables above so MCP
tools and lifecycle hooks can reach core. Do not use `LLM_PROVIDER=claude-code`
for hosted/team deployments where a server would run under one operator's
Claude Code subscription. Embeddings still use core's configured embedding
provider; select a local embedding provider separately for a fully local setup.

- `_API_URL` / `_API_KEY` / `_PROVIDER` / `_SCOPE_USER` — read by **both** the MCP server (for `memory_search` / `memory_ingest` / `memory_package` tool calls) and lifecycle hooks. All optional in local mode (see defaults above).
- `_CAPTURE_LEVEL` — controls lifecycle write volume. Valid values are `minimal`, `balanced`, and `full`. Defaults to `balanced` when unset; invalid values still fail closed.
- `_SCOPE_NAMESPACE` — used by both, as a per-project isolation boundary.
- `_SCOPE_AGENT` / `_SCOPE_THREAD` — forwarded to the MCP server as the request scope. The direct prompt-search path uses the core fast-search endpoint's supported user/namespace scope.

Lifecycle hooks attach a deterministic metadata payload to every captured record (`event`, `session_id`, `cwd`, `transcript_path`, `dedupe_key`, `schema_version`, plus per-hook fields such as `message_count` / `files_touched` / `tools_run` / `test_commands` on `on_stop`, and `task_id` / `tool_count` on `on_task_completed`). The payload is persisted to the memory's `metadata` column via core's `/v1/memories/ingest/quick` route. `_SCOPE_AGENT` / `_SCOPE_THREAD` are forwarded as scope, not embedded in the metadata blob itself today.

Optional capture controls:

- `ATOMICMEMORY_PROMPT_SEARCH_ENABLED=false` disables per-prompt retrieval.
- `ATOMICMEMORY_PROMPT_SEARCH_MIN_CHARS=20` controls the prompt-search threshold. If set, it must be a positive integer.
- `ATOMICMEMORY_PROMPT_SEARCH_LIMIT=5` controls prompt-search result count. If set, it must be a positive integer.
- `ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS=200` controls the minimum assistant text size for `Stop` capture. If set, it must be a positive integer. The 200 default was empirically tuned for Claude Code's typical multi-paragraph assistant responses; lower it (for example to 40) if your workflow produces consistently shorter stop turns you still want captured. Codex hosts that share the bundled Node hook runtime should consult the Codex plugin README's stop-threshold guidance for a host-specific recommendation.
- `ATOMICMEMORY_STOP_MAX_SUMMARY_CHARS=600` controls the maximum plain-text assistant response excerpt stored by `Stop`. If set, it must be a positive integer.
- `ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS=2400` controls the maximum cleaned `PostCompact` summary excerpt. If set, it must be a positive integer.
- `ATOMICMEMORY_TASK_MIN_TOOL_CALLS=5` controls the `TaskCompleted` threshold under `minimal` capture. If set, it must be a positive integer.
- `ATOMICMEMORY_TASK_MAX_DESCRIPTION_CHARS=600` controls the maximum cleaned task description excerpt stored by `TaskCompleted`. If set, it must be a positive integer.
- `ATOMICMEMORY_SEMANTIC_PROMPTS_ENABLED=false` disables extra Stop prompts that ask Claude to extract semantic learnings. If set, it must be `true` or `false`.

If a helper tool is unavailable, an explicit `ATOMICMEMORY_*` value is invalid (bogus capture level, non-numeric integer var, non-boolean flag), or core is unreachable, hooks surface the error instead of running in a degraded mode.

### 3. Install the plugin

From the cloned repo:

```bash
# Register this repo as a local marketplace (one-time)
claude plugin marketplace add ./

# Install the plugin
claude plugin install claude-code@atomicmemory
```

### 4. Update and verify an existing install

Claude Code updates are version-gated. If hook scripts, `hooks.json`, `.claude-plugin/plugin.json`, skills, or marketplace metadata changed, bump plugin versions from the repo root before relying on `claude plugin update`:

```bash
pnpm bump:plugin-versions patch
```

For Claude, the helper keeps these files in sync:

- `../../.claude-plugin/marketplace.json` at `/plugins/*/version`
- `.claude-plugin/plugin.json` at `/version`
- `package.json` at `/version`

If the version stays unchanged, `claude plugin update claude-code@atomicmemory` can report "already at the latest version" while the installed cache still contains older files.

After changing this repo, refresh Claude's installed plugin cache:

```bash
claude plugin marketplace list

# If the plugin is already installed:
claude plugin update claude-code@atomicmemory

# If the plugin is not installed yet:
claude plugin install claude-code@atomicmemory
```

The plugin spawns `@atomicmemory/mcp-server` from the npm registry via `npx`, so no local build is needed. If you're developing the MCP server itself and want Claude Code to load a local checkout instead, override the manifest's `mcpServers.atomicmemory.command`/`args` in a local settings file rather than editing the published manifest.

If `claude plugin marketplace list` shows `atomicmemory` pointing at an old checkout, replace the marketplace entry from this repo first:

```bash
claude plugin marketplace remove atomicmemory
claude plugin marketplace add ./ --scope user
claude plugin install claude-code@atomicmemory
```

Fully restart Claude Code after updating. Existing sessions can keep the old hook registration in memory even when the cache on disk has changed.

Smoke-test the installed PreCompact hook. It should print nothing and exit `0`:

```bash
PLUGIN_ROOT=$(ls -td ~/.claude/plugins/cache/atomicmemory/claude-code/* | head -n 1)
printf '{"trigger":"manual","session_id":"smoke"}' \
  | bash "$PLUGIN_ROOT/scripts/on_pre_compact.sh"
```

Then verify:

- `claude plugin list` shows `claude-code@atomicmemory` enabled.
- `/compact` is not blocked by `PreCompact`.
- A fresh Claude Code session can see `memory_search`, `memory_ingest`, `memory_package`, and `memory_list`.

## What's in this directory

```
plugins/claude-code/
├── .claude-plugin/
│   └── plugin.json          # plugin manifest
├── hooks/
│   └── hooks.json           # Claude Code lifecycle hook registrations
├── scripts/                 # lifecycle hook scripts
│   ├── block_memory_write.sh
│   ├── lib/
│   │   └── atomicmemory.sh
│   ├── on_post_compact.sh
│   ├── on_pre_compact.sh
│   ├── on_session_start.sh
│   ├── on_session_end.sh
│   ├── on_stop.sh
│   ├── on_stop_failure.sh
│   ├── on_task_completed.sh
│   └── on_user_prompt.sh
├── skills/
│   └── atomicmemory/
│       └── SKILL.md         # when/how the agent should call memory tools
└── README.md
```

The plugin spawns [`@atomicmemory/mcp-server`](../../packages/mcp-server) from the npm registry via `npx -y --package=@atomicmemory/mcp-server@^0.1.1 atomicmemory-mcp`, so a `claude plugin install` is self-contained — no local clone or build required. Most semantic memory operations go through the MCP tools. Latency-sensitive prompt retrieval uses `/v1/memories/search/fast` directly, and lifecycle scripts write deterministic records to `/v1/memories/ingest/quick` with `skip_extraction=true` because command hooks cannot talk to Claude Code's already-running stdio MCP child. Hook record content stays clean and human-readable; lifecycle provenance, scope, dedupe keys, session IDs, cwd, transcript paths, tool counts, and validation details are sent separately in request `metadata` and persisted to the memory's `metadata` JSONB column, with `sourceSite` / `sourceUrl` continuing to carry the provider/route identity.

## Lifecycle hooks

| Hook | What it does |
|---|---|
| `SessionStart` | Injects a bootstrap prompt telling Claude to call `memory_search` early. Different prompt for `startup` / `resume` / `compact`. |
| `UserPromptSubmit` | Searches memory for the current prompt via HTTP and injects matching memories as untrusted additional context. Skipped for short prompts, missing env, or `ATOMICMEMORY_PROMPT_SEARCH_ENABLED=false`. |
| `PreCompact` | No-op by design. It never blocks compaction; `PostCompact` handles deterministic summary capture. |
| `PostCompact` | Stores Claude Code's generated `compact_summary` as cleaned content, dropping `<analysis>` blocks, XML-ish tags, code blocks, and markdown-heavy formatting. Lifecycle event/source/session fields stay in metadata. |
| `Stop` | For meaningful turns, stores only the cleaned last assistant response as content. Tool counts, changed files, validation commands, session IDs, cwd, transcript paths, dedupe keys, and scope stay in metadata so searchable content remains human-readable. Optionally prompts Claude for durable decisions/preferences/anti-patterns. Guards against infinite loops via `stop_hook_active`. |
| `StopFailure` | Debug telemetry only; no memory write. |
| `SessionEnd` | Cleans local dedupe/last-write markers for the session. |
| `TaskCompleted` | Stores cleaned `task_subject` and optional cleaned `task_description` as content; task IDs, teammate/team names, tool counts, cwd, transcript paths, dedupe keys, and scope stay in metadata. |
| `PreToolUse` (Write\|Edit) | Blocks writes to `MEMORY.md` and adjacent memory-file paths — redirects agents to `memory_ingest`. |

Lifecycle writes are compact records, not raw prompt dumps. Hook scripts redact obvious secret-shaped values and strip fenced code blocks, XML-ish tags, markdown-heavy formatting, wrapper labels, and follow-up prompts from deterministic content before writing records.

### Hook runtime choice

The installed Claude Code plugin still ships the versioned shell hooks above. For manual hook configs, the AtomicMemory CLI can generate equivalent host snippets with a runtime choice:

```bash
# Recommended: bundled Node CLI hook runner.
atomicmemory hooks install --host claude-code --runtime node

# Advanced: emit config for a compatible Python hook runner.
atomicmemory hooks install --host claude-code --runtime python
```

Node is the default because it shares the TypeScript SDK adapter and CLI packaging. Python is an advanced option for Python-first environments; set `ATOMICMEMORY_PYTHON_HOOK_BIN` to a compatible Python hook runner before using the generated Python snippet.

When debugging CLI-generated Node hooks manually with `--json` or `--agent`, skipped runs include `meta.reason`: `prompt_too_short`, `no_content`, `no_hits`, or `low_signal`. Generated hook snippets keep skipped runs quiet so Claude Code receives no extra output unless memory context is available.

#### PATH verification

Claude Code hook environments are commonly spawned with a thinner PATH than the interactive shell that ran `atomicmemory hooks install`. Before relying on the generated snippet, confirm the bundled CLI resolves inside the hook environment:

```bash
command -v atomicmemory
```

If the command is not found, install `@atomicmemory/cli` globally or invoke it through a wrapper that puts the resolved bin on PATH.

## License

Apache-2.0.
