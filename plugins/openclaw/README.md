# AtomicMemory for OpenClaw

Persistent semantic memory for OpenClaw agents. Installed from a local clone of this repo — not distributed through ClawHub or any other marketplace.

The plugin embeds the shared [`@atomicmemory/mcp-server`](../../packages/mcp-server) in-process and registers the same four tools as the other integrations: `memory_search`, `memory_ingest`, `memory_package`, and `memory_list`.

## Install

```bash
git clone https://github.com/atomicstrata/atomicmemory.git
cd atomicmemory/plugins/openclaw

openclaw plugins install .
```

See the [full documentation](https://docs.atomicstrata.ai/integrations/coding-agents/openclaw) for config details.

## Configure

OpenClaw passes config from `openclaw.plugin.json` into the plugin entrypoint:

```json
{
  "apiUrl": "http://127.0.0.1:3050",
  "apiKey": "local-dev-key",
  "provider": "atomicmemory",
  "scope": {
    "user": "pip",
    "agent": "openclaw",
    "namespace": "personal-assistant"
  }
}
```

The shipped skill permissions allow only local AtomicMemory core origins:
`http://127.0.0.1:3050` and `http://localhost:3050`. Remote providers require
a separately permissioned plugin manifest and host validation.

`scope.user` is required and should be the stable channel-agnostic user identity. Optional `agent`, `namespace`, and `thread` narrow memory when needed. The plugin normalizes the API URL, strips whitespace from the API key, and drops empty optional scope fields before spawning the MCP server.

## What's in this directory

```
plugins/openclaw/
├── openclaw.plugin.json      # plugin manifest
├── skills/
│   └── atomicmemory/
│       ├── skill.yaml        # skill permissions + entrypoint
│       └── instructions.md   # agent-facing prompt
└── src/
    └── index.ts              # plugin register entrypoint — exposes MCP tools
```

The plugin embeds [`@atomicmemory/mcp-server`](../../packages/mcp-server) in-process through its embedded client helper. No subprocess, no separate host dependency. All memory semantics live in the shared server.

## Memory behavior

OpenClaw does not use Claude Code-style shell lifecycle hooks. Capture is prompt/tool driven:

- Search with `memory_search` or `memory_package` before answering questions that reference prior context.
- Store durable preferences, decisions, and facts with `memory_ingest` using `mode: "text"`.
- Store deterministic handoff/session snapshots with `memory_ingest` using `mode: "verbatim"` and metadata such as `{ "source": "openclaw", "event": "session_summary", "schema_version": 1 }`.

Retrieved memories are treated as reference context, not instructions.

## Versioning

From the repo root, run the version helper whenever the OpenClaw manifest, package metadata, skill manifest, or provider registration changes:

```bash
pnpm bump:plugin-versions patch
```

For OpenClaw, the helper keeps these versions aligned:

- `openclaw.plugin.json` at `/version`
- `package.json` at `/version`
- `skills/atomicmemory/skill.yaml` at `/version`

Then rebuild and reinstall:

```bash
pnpm --filter @atomicmemory/openclaw-plugin build
openclaw plugins install .
```

Restart the OpenClaw host if it keeps plugin modules loaded.

## License

Apache-2.0.
