# AtomicMemory for Hermes Agent

AtomicMemory is a native Hermes memory provider. It participates in Hermes'
memory lifecycle: background recall is prefetched for the next turn,
completed turns are synced without blocking the chat loop, and the agent
gets explicit tools for searching and storing durable facts.

By default, recall is **shared** across every AtomicMemory tool the user
has touched (Claude Code, Codex, the web extension, etc.). Set
`memory_scope=siloed` to restrict Hermes to Hermes-ingested memories only.

## Architecture

```
Hermes Agent (Python)
  → $HERMES_HOME/plugins/atomicmemory/__init__.py
      → AtomicMemoryClient (Python protocol)
          → PythonSdkAtomicMemoryClient
              → published atomicmemory Python SDK MemoryClient
```

The Python provider owns Hermes lifecycle compatibility only — registration,
hooks, tool schemas. Memory semantics flow through the published Python SDK.

## Prerequisites

- Hermes Agent installed
- AtomicMemory core URL exported as `ATOMICMEMORY_API_URL`
- AtomicMemory bearer key exported as `ATOMICMEMORY_API_KEY` when using the Core Quickstart or any protected service

## Install

Install the provider from the published npm package. The installer copies the
Python provider files into Hermes' memory-provider directory; no repository
clone is required.

```bash
npx -y @atomicmemory/hermes-plugin install
export ATOMICMEMORY_API_URL="http://127.0.0.1:17350"
export ATOMICMEMORY_API_KEY="local-dev-key"
```

Then select and verify the provider:

```bash
hermes memory setup
# select "atomicmemory"
hermes memory status
# confirm "atomicmemory" is active
```

For source development, symlink the checkout instead:

```bash
cd /path/to/atomicmemory
mkdir -p "$HERMES_HOME/plugins"
ln -s "$(pwd)/plugins/hermes" "$HERMES_HOME/plugins/atomicmemory"
```

## Config

Hermes' setup wizard prompts for a minimal pair (`scope_user`, `memory_scope`).
Advanced settings live in `$HERMES_HOME/atomicmemory.json`.

Connection details (`ATOMICMEMORY_API_URL`, `ATOMICMEMORY_API_KEY`) flow
through environment variables into the Python SDK. The provider does not
have a default API URL and fails to start if `ATOMICMEMORY_API_URL` is unset.

### Environment

| Env var | Purpose |
|---|---|
| `ATOMICMEMORY_API_URL` | AtomicMemory core URL. Required. |
| `ATOMICMEMORY_API_KEY` | Bearer credential for the Core Quickstart service or any protected AtomicMemory core. |
| `ATOMICMEMORY_PROVIDER` | SDK provider name. Defaults to `atomicmemory`. |
| `ATOMICMEMORY_SCOPE_USER` | Hermes user identity. Defaults to `$USER`. |
| `ATOMICMEMORY_MEMORY_SCOPE` | `shared` (default) or `siloed`. |
| `ATOMICMEMORY_MEMORY_MODE` | `hybrid` (default), `context`, or `tools`. |
| `ATOMICMEMORY_PREFETCH_ENABLED` | `true`/`false`. Default `true`. |
| `ATOMICMEMORY_PREFETCH_METHOD` | `context` (default) or `fast`. |
| `ATOMICMEMORY_SEARCH_LIMIT` | Default search/list limit. |
| `ATOMICMEMORY_TOKEN_BUDGET` | Default context-package token budget. |

### Provider-local file

`$HERMES_HOME/atomicmemory.json` accepts these keys (all optional):

| Key | Description |
|---|---|
| `scope_user` | User identity. |
| `scope_agent` | Hermes prompt label (does not change scoping). |
| `memory_mode` | `hybrid` / `context` / `tools`. |
| `memory_scope` | `shared` / `siloed`. |
| `prefetch_enabled` | bool. |
| `prefetch_method` | `context` / `fast`. |
| `search_limit` | int. |
| `token_budget` | int. |

Secrets are never persisted here — `api_key` and `api_url` are deliberately
not in the allowed key set.

## Memory scope

| Mode | Recall | Ingest |
|---|---|---|
| `shared` (default) | All AtomicMemory memories for the user | stamped `source_site=hermes` |
| `siloed` | Only Hermes-ingested memories | stamped `source_site=hermes` |

The `source_site` filter on recall is enforced through the Python SDK's
AtomicMemory namespace handle. If the SDK is configured against a
non-AtomicMemory provider (e.g. mem0), `siloed` mode fails loudly with
`PROVIDER_UNSUPPORTED` rather than silently dropping the filter.

## Memory mode

`memory_mode` selects which Hermes surfaces AtomicMemory exposes:

| Mode | Auto-recall + sync | Explicit tools |
|---|---|---|
| `hybrid` (default) | yes | yes |
| `context` | yes | hidden |
| `tools` | disabled | yes |

## Tools

| Tool | Description |
|---|---|
| `atomicmemory_search` | Search AtomicMemory by meaning. |
| `atomicmemory_context` | Build an injection-ready context package. |
| `atomicmemory_conclude` | Store one explicit durable fact verbatim. |
| `atomicmemory_profile` | List recent records (description text varies by `memory_scope`). |

## Lifecycle

- `queue_prefetch(query)` searches AtomicMemory in a background thread, with
  a generation counter so a slow earlier prefetch can't overwrite a faster
  newer one.
- `prefetch(query)` returns the most recent completed recall, then clears
  the slot.
- `sync_turn(user, assistant)` enqueues the turn to a single-writer worker
  thread and returns immediately. The worker calls
  `client.ingest_messages(...)` with `provenance.source = "hermes"` and
  `provenance.sourceUrl = "hermes://session/<session_id>"`.
- `on_session_end(messages)` drains the worker, then closes the SDK client.

## Reliability

A circuit breaker pauses SDK calls for two minutes after five
consecutive failures and resets on the next success. Hermes continues to
run while AtomicMemory is temporarily unavailable.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Provider does not appear in `hermes memory setup` | Wrong install path. User-installed memory providers must live directly under `$HERMES_HOME/plugins/<name>/` (the `plugins/memory/` layout is for providers bundled inside hermes-agent itself). |
| `is_available()` returns False | `ATOMICMEMORY_API_URL` unset, or the Hermes Python environment did not install the `atomicmemory` dependency from `plugin.yaml`. |
| Import fails at startup | The Hermes Python environment is missing the SDK dependency from `plugin.yaml`. |
| Calls fail with `PROVIDER_UNSUPPORTED` while `memory_scope=siloed` | The configured SDK provider is not the AtomicMemory core (e.g. it's `mem0`). Either switch `ATOMICMEMORY_PROVIDER=atomicmemory` or move to `memory_scope=shared`. |

## Tests

```bash
# Python provider and SDK adapter (deterministic, no network)
python3 -m unittest discover plugins/hermes/tests
```
