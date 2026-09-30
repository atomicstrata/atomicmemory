# Host integrations

Host plugins resolve the provider URL in three steps: explicit
`ATOMICMEMORY_API_URL` / `apiUrl`, else Cloud when an API key is set, else local
Core at `http://127.0.0.1:17350`. Cloud needs no local Core process: initialize
a project with `am init --cloud`, create a host-specific project API key, and
export that key (the Cloud URL is then selected automatically).

| Host | Cloud connection | Local Core | `am integrate` support |
|---|---|---|---|
| Claude Code | Plugin environment or CLI-managed MCP (`ATOMICMEMORY_API_KEY`) | Omit URL and key, or set `ATOMICMEMORY_API_URL=http://127.0.0.1:17350` | MCP config supported; plugin lifecycle hooks still read host environment variables |
| OpenClaw | Native plugin config (`apiKey`; Cloud URL when key set) | Omit `apiUrl` and `apiKey`, or set `apiUrl` to the local Core URL | Deferred; configure the native plugin directly |
| Hermes | Native provider environment (`ATOMICMEMORY_API_KEY`; Cloud URL when key set) | Omit URL and key, or set `ATOMICMEMORY_API_URL` to the local Core URL | Deferred; configure the native provider directly |

The native OpenClaw and Hermes integrations are not MCP host-config files, so
the current `am integrate` writer does not install or update them. Their
published installers and READMEs provide the supported no-clone setup. OAuth
for desktop host plugins is also deferred; these integrations use a Cloud
project API key.

## Gaps relative to the local-first App flow

| App-flow capability | Cloud-first disposition |
|---|---|
| Install and update from an App Integrations card | Deferred for native OpenClaw and Hermes plugins; use their published package installers. Claude MCP config is supported by `am integrate`. |
| Provision and hand a credential directly from the App | Deferred. The supported path is `am init --cloud` plus a host-specific `am key create`; the secret is shown once and configured in the host. |
| Verify with one App-owned write/read check | Deferred. Claude MCP uses `am integrate doctor`; OpenClaw and Hermes expose their host-native status and memory tools. |
| Manage plugin lifecycle from one App surface | Deferred for native plugins; OpenClaw and Hermes own enable, update, and removal lifecycle. |

See each host directory for install, verification, scope, and troubleshooting
details.
