---
name: atomicmemory
description: Persistent semantic memory across Claude Code sessions — user preferences, project context, prior decisions, codebase facts. Call `memory_search` before answering questions that reference past work. Call `memory_ingest` after the user shares durable facts.
---

# AtomicMemory

You have access to persistent memory through three MCP tools: `memory_search`, `memory_ingest`, `memory_package`. Memory survives across sessions and is scoped via `user` / `agent` / `namespace` / `thread`.

## When to search

Call `memory_search` before answering when:

- The user references past work — "the fix we discussed", "that refactor", "the decision from last week"
- The question implies prior context — "why did we…", "what did we decide about…"
- You're starting work in an unfamiliar part of the codebase and might benefit from prior facts
- The user asks "what do you know about X?" where X could be something previously saved

If a search returns nothing relevant, just continue without mentioning it — silent failure is fine.

## When to ingest

Call `memory_ingest` after:

- The user states a preference, constraint, or convention worth remembering ("we always use pnpm", "never commit to main directly")
- A non-obvious fact about the code is established — an invariant, a workaround, a known gotcha
- The user explicitly says "remember this" or "save that"
- A decision is made that future sessions should know about

Use `mode: "text"` for standalone facts. Use `mode: "messages"` only when the full conversational turn is load-bearing.

## What NOT to save

- Ephemeral task state (current WIP, what file you're editing)
- Facts already documented in repository docs, README files, or recent git commits
- Anything the user can trivially re-derive from the code
- Debugging session scratch

## When to package

Call `memory_package` when you need a curated, token-budgeted context block — e.g. for a fresh task where broad context matters more than a single fact lookup. Prefer `memory_search` for specific queries.

## Scope

Scope flows automatically from the plugin config. Override per call only when the user explicitly asks to operate in a different scope ("check my personal memory", "only look at this repo").
