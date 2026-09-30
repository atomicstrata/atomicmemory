# AtomicMemory for OpenClaw

Persistent semantic memory for OpenClaw agents. With an `apiKey` and no
`apiUrl`, the plugin targets AtomicMemory Cloud (no local Core process). With
neither set, it falls back to local Core at `http://127.0.0.1:17350`.

The plugin embeds the shared [`@atomicmemory/mcp-server`](../../packages/mcp-server) in-process and registers the same six tools as the other integrations: `memory_search`, `memory_ingest`, `memory_package`, `memory_list`, `entity_profile`, and `entity_attributes`. Requires `@atomicmemory/mcp-server@0.1.6` published on npm before this 0.2.3 plugin.

## Install

```bash
openclaw plugins install @atomicmemory/openclaw-plugin
```

See the [full documentation](https://docs.atomicstrata.ai/integrations/coding-agents/openclaw) for config details.

## Configure

Initialize a Cloud project and create a host-specific project API key:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://get.atomicstrata.ai/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
am init --cloud
am key create atomicmemory-openclaw
```

OpenClaw passes config from `openclaw.plugin.json` into the plugin entrypoint.
Copy the key printed once by `am key create` into `apiKey`:

```json
{
  "apiUrl": "https://api.atomicstrata.ai",
  "apiKey": "amc_…",
  "provider": "atomicmemory",
  "scope": {
    "user": "pip",
    "agent": "openclaw",
    "namespace": "personal-assistant"
  }
}
```

URL resolution: explicit `apiUrl` wins; else Cloud when `apiKey` is set; else
local Core at `http://127.0.0.1:17350` (with `local-dev-key`). `apiKey` is
required on the Cloud path. The local Core key `local-dev-key` is refused for
Cloud origins, and Cloud hostnames are refused over plain `http`. The shipped
skill permissions allow the Cloud origins and the two local Core origins.

For `provider=mem0` or an AtomicMemory deployment at a custom origin, also copy
or override the skill manifest and add that exact origin under
`permissions.network`. The shipped manifest intentionally does not grant
network access to arbitrary remote providers.

For local Core, omit both `apiUrl` and `apiKey`, or set them explicitly:

```json
{
  "apiUrl": "http://127.0.0.1:17350",
  "apiKey": "local-dev-key",
  "provider": "atomicmemory",
  "scope": { "user": "pip" }
}
```

`scope.user` should be the stable channel-agnostic user identity and defaults to
the local machine user. Optional `agent`, `namespace`, and `thread` narrow
memory when needed. The plugin normalizes the API URL, strips whitespace from
the API key, and drops empty optional scope fields before spawning the MCP
server.

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
- Store deterministic handoff/session snapshots with `memory_ingest` using `mode: "verbatim"`, `contentClass: "summary"`, `provenance: { source: "openclaw", sourceUrl: "openclaw://session/<id>" }`, and optional `metadata: { dedupe_key: "<stable-id>" }`. Put lineage in `provenance` rather than `metadata`. Core reserves a set of internal metadata keys (including `sourceSite`) and rejects them; other keys are accepted, so integration-specific values such as an event name or schema version can still go in `metadata`.

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
