# AtomicMemory × Langflow examples

Three importable flows, built and verified against a live AtomicMemory Core:

| File | What it shows |
|------|---------------|
| `atomicmemory_cross_session_demo.json` | **Minimal** cross-session memory (no LLM key needed). |
| `memory_chatbot_atomicmemory.json` | Langflow's **Memory Chatbot**, leveled up: session-local memory → durable **cross-session** memory. |
| `vector_store_rag_atomicmemory.json` | Langflow's **Vector Store RAG**, personalized: doc retrieval **+** cross-session memory of the user. |

All three put secrets via the field/`tweaks` (never the JSON), use Search Context
**user-scoped** (recall across sessions) in search mode, and force Store Message onto
the output path so writes always run.

---

# 1. Minimal cross-session memory demo (`atomicmemory_cross_session_demo.json`)

A minimal, **retrieval-grounded** flow that proves AtomicMemory gives a Langflow
assistant durable memory **across separate sessions** — with explicit, visible
writes and no hidden auto-ingest. No LLM key required: the Chat Output shows the
recalled memory directly. Verified end-to-end (Run 1 stores in session A, Run 2
recalls in session B).

## Flow shape (4 nodes)

```
Chat Input → AtomicMemory Store Message → AtomicMemory Search Context → Chat Output
```

- **Store Message** persists the user message (explicit write). It sits on the path to
  the output, so it always runs; its output feeds the next node.
- **Search Context** recalls **user-scoped** long-term memory (across sessions —
  `Scope to session` is off) in **search mode** (`Use packaged context` off, which is
  less threshold-sensitive for varied queries), and emits prompt-ready text.
- **Chat Output** shows the recalled context.

Both AtomicMemory nodes use `User ID = demo-dana` and `API URL = http://localhost:17350`.

## Prerequisites

- A running **AtomicMemory Core** at `http://localhost:17350` (needs an LLM/embeddings
  key for ingest extraction). Confirm: `curl -H "Authorization: Bearer <CORE_API_KEY>" http://localhost:17350/v1/memories/health`.
- **Langflow** with the AtomicMemory plugin (≥ 0.1.17) installed in its Python env
  (see `../README.md`).

## Secrets are NOT in this file

The **API Key** field is intentionally blank (it's a `SecretStrInput`; Langflow loads
secrets from its store, not the flow JSON). Supply your Core key (`local-dev-key` for
local dev) at run time:
- **UI:** open each AtomicMemory node and paste the key into **API Key**.
- **API:** pass it via `tweaks`, e.g.
  `tweaks: {"<StoreNodeId>": {"api_key": "local-dev-key"}, "<SearchNodeId>": {"api_key": "local-dev-key"}}`.

## Run it

Import via Langflow → **Settings → Import** → select the JSON, then set the API Key.

- **Run 1** (session A) — store durable context:
  > I'm Dana from Northstar Robotics. We use Langflow for internal support triage. I prefer concise technical answers, avoid Slack unless urgent, and our current priority is reducing agent latency.

  The Store Message node reports the ingest outcome; ingest is slow (Core extracts + embeds — seconds).

- **Run 2** (a **new session** B, same `demo-dana`) — recall:
  > Given what you know about me and my current priorities, help me plan the next implementation step.

  Chat Output returns the recalled facts — e.g. *"Dana's top priority is reducing agent
  latency. Dana prefers concise answers. User's name is Dana."* — even though it's a
  different session. That's cross-session memory.

## Notes

- **Search query phrasing matters.** The Search query references the user's context, so
  it retrieves the stored facts. A generic query (e.g. "plan the next step") may return
  nothing — semantic relevance, not a bug.
- **Extraction is non-deterministic.** Occasionally a turn extracts 0 facts; re-run Run 1
  with a fact-dense message and confirm with `GET /v1/memories/list?user_id=demo-dana`.
- To make this **model-backed** (an assistant answer instead of raw context), insert a
  Prompt + a chat-model component between Search Context and Chat Output, wiring the
  Search context as `{memory_context}` and the Chat Input as `{user_message}`. (That's
  exactly the next example.)

---

# 2. Memory Chatbot, leveled up (`memory_chatbot_atomicmemory.json`)

Langflow's **Memory Chatbot** starter uses the built-in `Memory` component — chat history
scoped to the *current* session, forgotten when the session changes. This version swaps
that for **AtomicMemory**, giving the bot **durable, cross-session, semantic** memory.

```
Chat Input ─┬─▶ Store Message ─▶ Search Context ─▶ Prompt.{memory}
            └────────────────────────────────────▶ Anthropic Model ─▶ Chat Output
                                       Prompt ─────▶ Anthropic Model
```

**Verified end-to-end** with an Anthropic model:
- Run 1 (session A): *"I'm Dana from Northstar Robotics; my priority is reducing agent latency; I prefer concise answers."*
- Run 2 (**new session** B): *"What's my current priority?"* → the bot answers *"Your current
  priority is reducing agent latency"* (and stays concise) — recalled across sessions.

Setup on import:
- **Model:** the `Anthropic Model` node references the `ANTHROPIC_API_KEY` Langflow global
  variable. Set that variable (Settings → Global Variables) or paste a key / swap in your
  preferred model component.
- **AtomicMemory:** set the **API Key** on the Store/Search nodes (or via `tweaks`), and a
  running Core at `http://localhost:17350`.

# 3. Personalized RAG (`vector_store_rag_atomicmemory.json`)

Langflow's **Vector Store RAG** starter answers from your documents. This version adds
**AtomicMemory** so the assistant *also* remembers the **user** across sessions — the Prompt
receives both the retrieved document `{context}` **and** the user's long-term `{memory}`:

```
File → Split → Knowledge Ingestion → Knowledge Base ─▶ parser ─▶ Prompt.{context}
Chat Input ─▶ Knowledge Base.search                              Prompt.{question}
Chat Input ─▶ Store Message ─▶ Search Context ─────────────────▶ Prompt.{memory}
Prompt ─▶ Anthropic Model ─▶ Chat Output
```

The AtomicMemory personalization is wired and verified (Store → Search → `Prompt.memory`,
same mechanism as #2). To run the **document** side you must supply your own documents and
populate the Knowledge Base — exactly as the original Vector Store RAG starter requires
(point the `File` node at your docs and run ingestion first). Model + AtomicMemory setup is
the same as #2 (`rag-dana` is the demo user).
