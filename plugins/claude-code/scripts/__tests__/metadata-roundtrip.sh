#!/usr/bin/env bash
#
# Optional helper-to-core HTTP smoke for the metadata wire path.
# **Not a CI gate** — runs only when `ATOMICMEMORY_CORE_URL` is
# set; intended for local-stack verification before posting a PR.
#
# Scope: helper smoke. Calls `am_ingest_verbatim` directly with
# three representative payloads (one per lifecycle hook shape:
# on_stop, on_task_completed, on_post_compact), then `curl`s
# `/v1/memories/list` to verify the persisted `metadata` column
# round-trips. Cleans up inserted rows at the end.
#
# This script does NOT exercise the actual hook entrypoint
# scripts (`on_stop.sh` etc.) — those need fixture stdin/env to
# simulate the Claude Code runtime. End-to-end coverage of each
# hook lives in the PR description's manual-verification line:
# "triggered each lifecycle event against a dev core; confirmed
# the row's metadata column matched."
#
# Required env (script exits cleanly if not set):
#   ATOMICMEMORY_CORE_URL  — base URL of a running core, e.g.
#                            http://localhost:3050

set -euo pipefail

if [ -z "${ATOMICMEMORY_CORE_URL:-}" ]; then
  printf '[smoke] ATOMICMEMORY_CORE_URL not set — skipping (this script is opt-in)\n'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="$SCRIPT_DIR/../lib/atomicmemory.sh"

# UUID for this smoke run; lets us reliably list-and-clean.
TEST_USER="00000000-0000-0000-0000-$(openssl rand -hex 6 2>/dev/null || printf '000000000abc')"

export AM_SCOPE_USER="$TEST_USER"
export AM_API_URL="$ATOMICMEMORY_CORE_URL"
export ATOMICMEMORY_PROVIDER="atomicmemory"
export ATOMICMEMORY_CAPTURE_LEVEL="balanced"

# shellcheck source=../lib/atomicmemory.sh
source "$LIB_PATH"

PASS=0
FAIL=0
INSERTED_IDS=()

cleanup() {
  for id in "${INSERTED_IDS[@]}"; do
    curl -sS -X DELETE \
      "$ATOMICMEMORY_CORE_URL/v1/memories/$id?user_id=$TEST_USER" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

assert_roundtrip() {
  local label="$1"
  local metadata_json="$2"

  printf '\n[%s] sending...\n' "$label"
  am_ingest_verbatim "test content for $label" "$metadata_json" "smoke-$label-$$"

  # Find the row via /list filtered by source_site; pluck the
  # most recent matching memory.
  local list_response
  list_response=$(curl -sS \
    "$ATOMICMEMORY_CORE_URL/v1/memories/list?user_id=$TEST_USER&source_site=claude-code")

  local matched
  matched=$(printf '%s' "$list_response" \
    | jq -c --argjson md "$metadata_json" \
      '.memories | map(select(.metadata == $md)) | first // null')

  if [ "$matched" = "null" ]; then
    printf '  ✗ %s: no row with matching metadata found\n' "$label" >&2
    printf '    /list returned: %s\n' "$list_response" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi

  local row_id
  row_id=$(printf '%s' "$matched" | jq -r '.id')
  INSERTED_IDS+=("$row_id")
  printf '  ✓ %s: row %s has expected metadata\n' "$label" "$row_id"
  PASS=$((PASS + 1))
}

# Representative payloads, one per lifecycle hook shape.
META_STOP='{"source":"claude-code","event":"stop","session_id":"smoke-1","schema_version":1}'
META_TASK='{"source":"claude-code","event":"task_completed","task_id":"smoke-2","tool_count":3,"schema_version":1}'
META_COMPACT='{"source":"claude-code","event":"post_compact","session_id":"smoke-3","schema_version":1}'

assert_roundtrip "on_stop" "$META_STOP"
assert_roundtrip "on_task_completed" "$META_TASK"
assert_roundtrip "on_post_compact" "$META_COMPACT"

printf '\n--- %d passed, %d failed ---\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
