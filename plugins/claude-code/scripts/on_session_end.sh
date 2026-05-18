#!/usr/bin/env bash
# Hook: SessionEnd
#
# Cleans local lifecycle-hook marker files for the ending Claude Code
# session. Does not write memory.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
REASON=$(echo "$INPUT" | jq -r '.reason // "unknown"' 2>/dev/null || echo "unknown")
SAFE_SESSION=$(am_safe_name "$SESSION_ID")
CACHE_DIR=$(am_cache_dir)

am_debug "SessionEnd cleanup for session=$SESSION_ID reason=$REASON"

if [ -d "$CACHE_DIR" ]; then
  find "$CACHE_DIR" -type f -name "session-$SAFE_SESSION.lastwrite" -delete 2>/dev/null || true
fi

exit 0
