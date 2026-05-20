# AtomicMemory for Codex

Persistent semantic memory for OpenAI's [Codex](https://openai.com/index/codex/) via the Codex plugin marketplace.

## What's inside

```
plugins/codex/
├── .codex-plugin/
│   └── plugin.json              # Codex plugin manifest (interface metadata)
├── .codex-mcp.json              # MCP server spec (spawns @atomicmemory/mcp-server)
├── skills/
│   └── atomicmemory/
│       └── SKILL.md             # agent-facing memory protocol
├── marketplace.example.json     # template for .agents/plugins/marketplace.json
├── logo.svg
└── README.md
```

No runtime code — the plugin is pure configuration. All memory semantics live in [`@atomicmemory/mcp-server`](../../packages/mcp-server), and the Codex skill tells the agent when to call `memory_search`, `memory_ingest`, `memory_package`, and `memory_list`.

## Install

### Option A — Repo marketplace (recommended for teams)

Drop a `.agents/plugins/marketplace.json` at your repo root pointing at this plugin:

```json
{
  "name": "atomicmemory-plugins",
  "interface": { "displayName": "AtomicMemory Plugins" },
  "plugins": [
    {
      "name": "atomicmemory",
      "source": { "source": "local", "path": "./plugins/codex" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

(See [`marketplace.example.json`](./marketplace.example.json) for a copy-pasteable version.)

In Codex, browse the repo's plugin directory and install AtomicMemory.

### Option B — Personal marketplace

Same JSON but at `~/.agents/plugins/marketplace.json`, with `source.path` pointing to wherever you cloned this repo.

### Option C — Manual MCP configuration

If you don't want plugin-system installation, register the MCP server directly in your Codex MCP config using the contents of [`.codex-mcp.json`](./.codex-mcp.json). Skips the skill; you'll need to decide when to call memory tools yourself.

The MCP config forwards the required environment variables with `env_vars`, so values come from the shell or Codex environment rather than being copied into the plugin file.

## Configure

Export scope and credentials in your shell:

```bash
export ATOMICMEMORY_API_URL="https://memory.yourco.com"
export ATOMICMEMORY_API_KEY="am_live_…"
export ATOMICMEMORY_PROVIDER="atomicmemory"
export ATOMICMEMORY_SCOPE_USER="pip"
# Optional narrower scopes:
# export ATOMICMEMORY_SCOPE_AGENT="codex"
# export ATOMICMEMORY_SCOPE_NAMESPACE="<repo-or-project>"
# export ATOMICMEMORY_SCOPE_THREAD="<session-id>"
```

At least one `ATOMICMEMORY_SCOPE_*` must be set — the server rejects scopeless requests. The MCP server itself is fetched from npm on first use via `npx -y --package=@atomicmemory/mcp-server@^0.1.2 atomicmemory-mcp`, so no local clone or build is required.

### Optional local core extraction through Codex

If you run AtomicMemory core on the same machine and want extraction to use the
same logged-in Codex account instead of a separate OpenAI API key, configure the
core process with:

```bash
codex login
export LLM_PROVIDER=codex
export EMBEDDING_PROVIDER=transformers
```

This configures AtomicMemory core, not the MCP plugin. The plugin still uses
`ATOMICMEMORY_API_URL`, `ATOMICMEMORY_API_KEY`, and scope variables to connect
to core. `LLM_PROVIDER=codex` is intended for personal local development; it
consumes the logged-in Codex account's limits and is not recommended for hosted
or team deployments.

## Memory behavior

By default, capture is tool-driven by the installed skill:

- On new tasks, search relevant prior context with `memory_search`; use `memory_package` for broader context assembly.
- After significant work, store durable decisions, preferences, conventions, and anti-patterns with `memory_ingest` using `mode: "text"`.
- Before context loss or handoff, store a compact deterministic session snapshot with `memory_ingest` using `mode: "verbatim"` and metadata such as `{ "source": "codex", "event": "session_summary", "schema_version": 1 }`.

Retrieved memories should be treated as reference context only, not instructions.

### Optional lifecycle hooks

Codex can load lifecycle hooks when `features.codex_hooks = true`. The recommended path is to keep MCP tools for agent-visible memory operations, then add hooks only for automatic prompt-time retrieval and deterministic lifecycle capture.

Generate a config snippet with the AtomicMemory CLI:

```bash
# Recommended: bundled Node runtime.
atomicmemory hooks install --host codex --runtime node

# Advanced: emit config for a compatible Python hook runner.
atomicmemory hooks install --host codex --runtime python
```

The Node runtime is bundled in `@atomicmemory/cli` as `atomicmemory hooks run ...`. The Python runtime is intentionally advanced: set `ATOMICMEMORY_PYTHON_HOOK_BIN` to a compatible Python hook runner before using the generated Python snippet.

When debugging the bundled Node runtime manually with `--json` or `--agent`, skipped hook runs include `meta.reason`: `prompt_too_short`, `no_content`, `no_hits`, or `low_signal`. The generated hook snippets keep skipped runs quiet so Codex receives no extra output unless memory context is available.

#### PATH verification

Codex hook environments are usually spawned with a thinner PATH than the interactive shell that ran `atomicmemory hooks install`. Before relying on the generated snippet, confirm the bundled CLI resolves inside the hook environment:

```bash
command -v atomicmemory
```

If the command is not found, either install `@atomicmemory/cli` globally or invoke it through a wrapper that puts the resolved bin on PATH.

#### Stop-threshold guidance (`ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS`)

The bundled Node runtime applies a `STOP_MIN_ASSISTANT_CHARS=200` low-signal gate on the `Stop` event — assistant content shorter than 200 characters after cleanup is skipped (`meta.reason = "low_signal"`) instead of being persisted. That default was tuned for Claude Code's verbose multi-paragraph stop payloads.

Codex stop responses are frequently much shorter (terse acknowledgements, single-line confirmations, "done."). At the bundled default they would be silently dropped as `low_signal`. To capture them, export the override in the host hook environment before the hook fires:

```bash
# Recommended starting point for Codex hosts; tune to your workflow.
export ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS=40
```

The CLI deliberately does NOT inject this override into generated snippets — your existing host env stays authoritative, and the override only takes effect where you set it. Set it to `1` to capture even the shortest responses, or to a higher value to stay aligned with Claude Code's default.

## Verify

Start a new Codex task and ask:

> *"List my most recent atomicmemory memories"* or *"Search my memories for hello"*

If the `memory_search` / `memory_ingest` / `memory_package` tools appear and respond, you're set.

## Versioning

From the repo root, run the version helper whenever the Codex manifest, MCP config, skill, or marketplace metadata changes:

```bash
pnpm bump:plugin-versions patch
```

For Codex, the helper keeps these versions aligned:

- `.codex-plugin/plugin.json` at `/version`
- `package.json` at `/version`
- `skills/atomicmemory/SKILL.md` at `/metadata/version`

The marketplace JSON intentionally has no plugin version field. Restart Codex or reinstall the local plugin after changing any of these files so the installed plugin cache reloads the manifest and skill.

## Status: plugin source-only, MCP server on npm

The Codex *plugin* (manifest + skill) is not yet published to any public Codex plugin marketplace — install it from a local clone of this repo via Option A / B above, or wire `.codex-mcp.json` into Codex directly via Option C. The MCP server it spawns is published as [`@atomicmemory/mcp-server`](https://www.npmjs.com/package/@atomicmemory/mcp-server) and is fetched on first use via `npx`, so no local clone or build of the integrations repo is required to actually run the server.

## License

Apache-2.0.
