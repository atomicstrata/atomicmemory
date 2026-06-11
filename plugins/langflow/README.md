# AtomicMemory components for Langflow

Four Langflow custom components backed by the Python `atomicmemory` SDK:

They appear in the Langflow component sidebar under the **atomicmemory** category:

| Component | Purpose |
|-----------|---------|
| **Chat Memory (AtomicMemory)** | Read-only chat history (Message History backend) from a user/session scope. |
| **Search Context (AtomicMemory)** | Query-driven, prompt-ready memory context, **user-scoped across sessions** by default (packaged or search-only). |
| **Store Message (AtomicMemory)** | Explicitly persist a message/turn into memory. |
| **Delete Memories in Scope (AtomicMemory)** | Best-effort erasure of a scope's memories (confirm-gated). |

## Requirements & compatibility

- Python ≥ 3.10, `atomicmemory >= 1.0.1`, `langchain-core`.
- **Langflow is the host** and must be installed in the same environment.
  Tested with Langflow `>=1.6,<2.0` (the components import a few `lfx` internals;
  see the loader smoke test). Newer Langflow majors may move these symbols.
- A running **AtomicMemory Core** (default `http://localhost:17350`). Core needs
  an LLM/embeddings key for ingest extraction.

> **Heads up:** ingest runs synchronous LLM extraction + embedding, so storing a
> memory can take **seconds (sometimes ~20s)**. Writes are explicit (Store Message)
> so this latency is visible, not hidden. Chat Memory is **read-only** — it never
> auto-writes on every turn. If the backend is unreachable, Chat Memory **fails
> closed** (raises a clear error) by default; set its `Fail open on error` toggle
> to return empty history instead.

## Install

```bash
pip install atomicmemory-langflow            # into Langflow's environment
# copy the component entry files into your Langflow components root:
npx @atomicmemory/langflow-plugin --target ~/.langflow/components --python <langflow-python>
# or set the components root via env instead of --target:
LANGFLOW_COMPONENTS_PATH=~/.langflow/components npx @atomicmemory/langflow-plugin --python <langflow-python>
```
Restart Langflow; the components appear under the **atomicmemory** category.

## Scope, identity & multi-tenant safety

Memory is scoped by `user` (required) and optional `session` (thread).
`User ID` defaults to the **Langflow run user** when blank; an explicit value
overrides it. Note this is run context, not strong auth — in CLI/anonymous paths
Langflow may auto-generate an opaque user id.

**Search Context recalls user-scoped (across sessions) by default** — long-term
memory should persist beyond a single conversation, and Core hard-filters
search/list by session. Set its advanced `Scope to session` toggle to restrict
retrieval to the current session. Chat Memory (this-conversation history) and
Store Message remain session-aware.

(`namespace` is not exposed in Phase 1: the AtomicMemory Python provider only
applies it on search/package, not ingest/list/delete, so exposing it would
silently break store/delete scoping. It returns once the SDK honors it end-to-end.)

**Trust boundary:** scope is the only memory boundary, and Langflow lets `user_id`/
`session_id` be set via flow inputs/tweaks. In shared / multi-tenant / Cloud
deployments, control who can edit and run flows — a flow author who sets `user_id`
can read/write that user's memories.

## Security

- Put API keys only in the **API Key** (secret) field — never in **Provider Config**
  (it is stored in plaintext in the flow). **Provider Config is allowlist-only**:
  only known tuning keys (`timeoutSeconds`, `apiVersion`) are accepted; everything
  else — URLs, keys, and any secret-shaped key (`accessToken`, `clientSecret`, …) —
  is rejected.
- **`provider` is validated**: Phase 1 accepts only `atomicmemory`, even via API/tweaks
  (the UI dropdown is not the only guard).
- **`API URL` is fail-closed for remote hosts.** It must be `http(s)` and resolve to a
  local host by default; pointing memory at a non-local endpoint requires the
  **operator** (not the flow author) to opt in via `ATOMICMEMORY_LANGFLOW_ALLOW_REMOTE=1`
  or `ATOMICMEMORY_LANGFLOW_ALLOWED_HOSTS=host1,host2`. **This is not full SSRF
  protection:** it does not sandbox the loopback interface, so a flow author can still
  reach services bound to the Langflow host's `localhost`/`127.0.0.1` (any port). Treat
  flow authors as trusted, or add network-egress controls, on shared/multi-tenant/cloud
  deployments.
- Retrieved memory is emitted as ordinary context, never as a system message.

## Provider neutrality

`provider` defaults to `atomicmemory` (the only Phase 1 tested provider). The
architecture is provider-neutral — provider name + `provider_config` flow to the
SDK — but other providers are not yet listed in the dropdown.

## Testing & known follow-ups

Unit tests run without a live backend (`cd plugins/langflow && python -m unittest
discover -s tests`); the SDK-contract and Langflow-loader tests exercise the real
`atomicmemory` SDK models and `lfx` template builder when those packages are
installed.

Follow-ups (tracked, not yet in this PR):
- **End-to-end lane against a real AtomicMemory Core** (Docker + Core + an LLM key):
  Store Message → Search Context → Delete with synthetic data, with the package
  installed into a Langflow-compatible venv. Unit tests use fakes/model coercion;
  this lane would catch integration drift the fakes can't.
- **Namespace scoping** once the Python SDK honors it on ingest/list/delete (today
  only search/package), at which point the `namespace` input returns.
- **Branded AtomicMemory icon** (vendor logo, like the model providers') — **deferred**.
  Each component currently uses a distinct Lucide icon (`save` / `search` /
  `messages-square` / `trash`). A real brand mark is a Langflow *vendor icon*, which
  per Langflow's docs requires frontend changes (an `@/icons/AtomicMemory` SVG +
  forwardRef wrapper + a `lazyIconImports` entry) and so cannot ship from a Python
  component bundle — it needs an upstream Langflow PR. Logo SVGs exist under
  `supermem-internal-web/static/img/`.
