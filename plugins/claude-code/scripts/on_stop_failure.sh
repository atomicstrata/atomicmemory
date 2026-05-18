#!/usr/bin/env bash
# Hook: StopFailure
#
# Debug telemetry only. Stop failures are not durable user memories.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atomicmemory.sh
if ! . "$SCRIPT_DIR/lib/atomicmemory.sh"; then
  printf '[atomicmemory-hook] failed to load helper library\n' >&2
  exit 1
fi

INPUT=$(cat)
ERROR_TYPE=$(echo "$INPUT" | jq -r '.error_type // "unknown"' 2>/dev/null || echo "unknown")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")

am_debug "StopFailure session=$SESSION_ID error_type=$ERROR_TYPE"

exit 0
