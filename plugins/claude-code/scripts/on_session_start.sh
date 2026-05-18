#!/usr/bin/env bash
# Hook: SessionStart (matcher: startup|resume|compact)
#
# Prompts Claude to bootstrap context via the atomicmemory MCP
# tools at the start of every session. Output becomes part of
# Claude's context — no direct API calls here; we delegate memory
# ops to the MCP server so auth and scope stay in one place.
#
# Input:  JSON on stdin with session_id, source, transcript_path, cwd
# Output: Text injected into Claude's context (exit 0)

set -uo pipefail

command -v jq >/dev/null 2>&1 || {
  echo "AtomicMemory SessionStart hook requires jq." >&2
  exit 1
}

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")

case "$SOURCE" in
  startup)
    cat <<'EOF'
## AtomicMemory Session Bootstrap

You have access to persistent memory via three MCP tools: `memory_search`, `memory_ingest`, `memory_package`. Before doing anything else:

1. Call `memory_search` with a query related to the current project, repo, or user topic to load relevant prior context.
2. Review the returned memories to understand what has been learned in prior sessions.
3. For broader context tasks, call `memory_package` — AtomicMemory will assemble a token-budgeted context block for you.

IMPORTANT: Do NOT skip this step. Always bootstrap context first.
EOF
    ;;
  resume)
    cat <<'EOF'
## AtomicMemory Session Resumed

Before continuing:

1. Call `memory_search` with a query related to the current task to refresh relevant memories.
2. If significant time has passed, search for recent project-wide updates.

Then continue where you left off.
EOF
    ;;
  compact)
    cat <<'EOF'
## AtomicMemory Post-Compaction Recovery

Context was just compacted — you may have lost important session state. Before continuing:

1. Call `memory_search` with queries related to what you were working on to reload relevant knowledge.
2. Check for any `session_state` memories saved before compaction.
3. Continue based on the recovered context.
EOF
    ;;
esac

exit 0
