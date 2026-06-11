# Changelog

## 0.1.17
- Version synchronized with the other atomicmemory-internal plugins (claude-code,
  codex, cursor, hermes, openclaw all at 0.1.17). Future versions track that
  shared plugin version rather than per-change bumps.
- Fix Message-typed inputs being stringified as JSON. Search Context `query` and
  Store Message `message`, when fed from another component's Message output,
  arrived as Message objects whose `str()` is JSON (`{"text": ...}`) — corrupting
  the search query / ingest content. Now extract `.text` (`coerce_text`). This
  made flow-wired recall flaky/empty.

## 0.1.3
- Search Context now recalls **user-scoped** (across sessions) by default — the
  point of long-term memory. Previously it scoped retrieval to the Langflow run
  `session_id`, and since Core hard-filters search/list by session, "store in
  session A, recall in session B" returned nothing. New advanced input
  `Scope to session` (default off) restores session-only retrieval when wanted.
  Store Message / Chat Memory session behavior is unchanged.

## 0.1.2
- Rename component display names to lead with the function (e.g. "Store Message
  (AtomicMemory)") instead of "AtomicMemory …". Under the `atomicmemory` sidebar
  category the old prefix was redundant and truncated to an indistinguishable
  "AtomicMemory…" for all four. Internal `name`s are unchanged.

## 0.1.1
- Fix `langchain-core` dependency pin (`<1.0` → `<2.0`) so the package installs
  alongside Langflow, whose `lfx` requires `langchain-core>=1.2.28`. Verified
  running against `langchain-core` 1.4.0; our code only uses stable APIs.

## 0.1.0
- Initial release: AtomicMemory Chat Memory (read-only), Search Context,
  Store Message, and Delete components for Langflow, backed by the
  `atomicmemory` Python SDK.
