#!/usr/bin/env bash
# Hook: PreToolUse (matcher: Write|Edit)
#
# Blocks writes to MEMORY.md and adjacent auto-memory files so the
# agent uses the `memory_ingest` MCP tool as the single source of
# truth for durable memory.
#
# Input:  JSON on stdin with tool_name, tool_input
# Output: stderr message (exit 2 = block)
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to Claude as feedback)

set -uo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "AtomicMemory memory-write guard requires jq." >&2
  exit 1
}

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  MEMORY.md|*/MEMORY.md|*/.atomicmemory/*|*/.claude/*/memory/*)
    echo "BLOCKED: Do not write to $FILE_PATH. Use the \`memory_ingest\` MCP tool instead - this project uses AtomicMemory for all durable memory, so file-based notes will drift from the semantic store." >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
