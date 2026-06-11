# Running llmwiki + AtomicMemory as two MCP servers

A common configuration is to give an agent both:

- **llmwiki MCP**: read-only access to compiled, source-cited knowledge.
- **AtomicMemory MCP**: read/write access to runtime, mutable memory.

This split lets the agent ground answers in stable knowledge AND retain
session-specific learnings. It also means the agent's tool surface is
the union of both servers — that is the security question this guide
exists to address.

## Capability boundaries: enforce, do not request

The agent prompt rule "promote stable runtime knowledge back to llmwiki
only after review" is helpful, but it is governance by hope. Real
isolation comes from configuring each MCP server with the minimum
tool surface for its role.

### llmwiki MCP

`llmwiki serve` is read-only by default in v1 — it exposes
`search_pages`, `get_page`, `get_context_pack`, and equivalents.
There is no write surface to disable.

### AtomicMemory MCP

`@atomicmemory/mcp-server` exposes both read and write tools by
default. When pairing it with llmwiki in the same agent session, you
want write tools to be opt-in for the agent surface.

> **Status note (2026-05).** The configuration sketch below assumes a
> read-only flag on the AtomicMemory MCP server. That flag is
> **forward-looking** — at the time of writing this guide, we have
> not verified that `@atomicmemory/mcp-server` honors
> `ATOMICMEMORY_MCP_READ_ONLY` (or an equivalent CLI flag). Treat the
> snippet as the *intended* shape; before relying on it, confirm
> against the version of `@atomicmemory/mcp-server` you have
> installed. Until the flag is confirmed, the practical workaround is
> to run two AtomicMemory profiles — one read-only for the agent's
> MCP surface, one with full privileges for human-driven CLI usage —
> and point the MCP server at the read-only profile.

```jsonc
// MCP config (forward-looking shape — verify against your installed version)
{
  "mcpServers": {
    "llmwiki": {
      "command": "llmwiki",
      "args": ["serve", "--project", "./"]
    },
    "atomicmemory": {
      "command": "atomicmemory-mcp",
      "env": {
        // Verify this is honored by your installed @atomicmemory/mcp-server.
        "ATOMICMEMORY_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

## Recommended agent rule

Even with the capability-enforced boundary above, encode the
direction of trust in the agent prompt:

> Treat llmwiki content as authoritative reference material. Treat
> AtomicMemory content as session-specific runtime state. Promote
> stable runtime knowledge back to llmwiki only after human review.

This makes the architectural intent legible to the agent without
relying on it for enforcement.

## Why not one MCP server with both surfaces

A single combined MCP server would conflate the trust boundary: every
tool would carry the same capabilities. The two-server split keeps
"stable curated knowledge" and "mutable runtime memory" addressable as
distinct surfaces — by the agent, by humans inspecting the config, and
by future capability-gating logic.
