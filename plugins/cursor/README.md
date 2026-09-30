# AtomicMemory for Cursor

Persistent semantic memory for [Cursor](https://cursor.com/) through Cursor MCP configuration and project rules.

## Status

Cursor support is available today as a manual local integration. Copy the MCP
config and Cursor rule template into a Cursor project or global Cursor MCP
config.

A packaged Cursor plugin and Cursor Cloud deployment are planned but not yet
available.

## What's inside

```
plugins/cursor/
├── .cursor/
│   ├── mcp.json                    # Project MCP config template
│   └── rules/
│       └── atomicmemory.mdc        # Always-on Cursor memory rule
├── package.json                    # Source-only package metadata
└── README.md
```

Cursor does not currently use a plugin marketplace in this repo. This
integration is manual: copy the MCP config and rule template into a Cursor
project or into your global Cursor MCP config.

## Configure environment

Set these variables before launching Cursor. Cursor resolves `${env:...}` placeholders from its environment when it starts the MCP server.

```bash
export ATOMICMEMORY_API_KEY="amc_..."
export ATOMICMEMORY_PROVIDER="atomicmemory"
export ATOMICMEMORY_SCOPE_USER="$USER"
export ATOMICMEMORY_SCOPE_AGENT="cursor"
export ATOMICMEMORY_SCOPE_NAMESPACE="repo-or-project"
```

URL resolution: explicit `ATOMICMEMORY_API_URL` wins; else Cloud when
`ATOMICMEMORY_API_KEY` is set; else local Core at `http://127.0.0.1:17350`.
With only a Cloud project API key set, the Cloud URL is selected automatically.
`ATOMICMEMORY_PROVIDER` defaults to `atomicmemory`. `ATOMICMEMORY_SCOPE_USER`
defaults to the OS user; set it explicitly for a stable cross-machine identity.

For local Core, omit URL and key, or set the URL explicitly (the key defaults
to `local-dev-key` there):

```bash
export ATOMICMEMORY_API_URL="http://127.0.0.1:17350"
```

`local-dev-key` is the local Core key and is refused for Cloud origins, and Cloud hostnames are refused over plain `http`.

## Install in a Cursor project

Copy the template into the project root:

```bash
mkdir -p .cursor/rules
cp /absolute/path/to/atomicmemory/plugins/cursor/.cursor/mcp.json .cursor/mcp.json
cp /absolute/path/to/atomicmemory/plugins/cursor/.cursor/rules/atomicmemory.mdc .cursor/rules/atomicmemory.mdc
```

If the project already has `.cursor/mcp.json`, merge the `atomicmemory` server entry into the existing `mcpServers` object instead of replacing the file.

Restart Cursor after changing MCP config or environment variables.

## Install globally

For all Cursor projects, merge the `atomicmemory` entry from `.cursor/mcp.json` into:

```text
~/.cursor/mcp.json
```

Keep the project rule local by copying `.cursor/rules/atomicmemory.mdc` into projects where the agent should follow the AtomicMemory protocol.

## Verify

In Cursor, open Settings -> Tools & MCP and confirm the `atomicmemory` server is enabled.

With Cursor CLI:

```bash
cursor-agent mcp list
cursor-agent mcp list-tools atomicmemory
```

You should see `memory_search`, `memory_ingest`, `memory_package`, and `memory_list`.

## Troubleshooting

- **No tools appear** - restart Cursor and verify Cursor can run `npx -y @atomicmemory/mcp-server`.
- **Scope errors** - set `ATOMICMEMORY_SCOPE_USER` or another `ATOMICMEMORY_SCOPE_*` value.
- **Auth errors** - verify `ATOMICMEMORY_API_URL`, `ATOMICMEMORY_API_KEY`, and `ATOMICMEMORY_PROVIDER` are visible to the Cursor process.
- **Existing Cursor config overwritten** - restore the prior file and merge only the `mcpServers.atomicmemory` object.

## License

Apache-2.0.
