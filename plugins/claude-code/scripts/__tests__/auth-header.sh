#!/usr/bin/env bash
#
# Unit gate for the Bearer auth header behavior of the hooks'
# direct-to-core HTTP calls in
# `plugins/claude-code/scripts/lib/atomicmemory.sh`.
#
# Shadows `curl` with a bash function that captures argv to a file,
# then exercises `am_post_quick_ingest` and `am_search_fast` with
# AM_API_KEY both set and unset. Asserts:
#   1. With AM_API_KEY set, both curl invocations include
#      `-H Authorization: Bearer <key>`.
#   2. With AM_API_KEY empty, neither invocation includes the
#      Authorization header.
#
# Matches core's `requireBearer` middleware contract
# (atomicmemory-core/src/middleware/require-bearer.ts).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="$SCRIPT_DIR/../lib/atomicmemory.sh"

if [ ! -f "$LIB_PATH" ]; then
  printf 'fixture path missing: %s\n' "$LIB_PATH" >&2
  exit 1
fi

unset ATOMICMEMORY_API_KEY
unset ATOMICMEMORY_API_URL
export USER="${USER:-test-user}"

# shellcheck source=../lib/atomicmemory.sh
source "$LIB_PATH"

ARGV_LOG="$(mktemp)"
trap 'rm -f "$ARGV_LOG"' EXIT

# Shadow curl with a bash function that writes its full argv to the
# log file (one arg per line, with a record separator between calls)
# and emits a 200 OK so the caller path completes happily.
curl() {
  printf '%s\n' "$@" >>"$ARGV_LOG"
  printf '---END---\n' >>"$ARGV_LOG"
  for arg in "$@"; do
    case "$arg" in
      -w|--write-out) printf '200' ;;
    esac
  done
}
export -f curl

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  local name="$1"
  local condition="$2"
  if [ "$condition" = "true" ]; then
    printf '  ✓ %s\n' "$name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✗ %s\n' "$name" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

reset_log() {
  : >"$ARGV_LOG"
}

argv_contains_header() {
  local header_value="$1"
  awk -v target="$header_value" '
    /^-H$/ { capture = 1; next }
    capture { if ($0 == target) { found = 1 } capture = 0 }
    END { exit (found ? 0 : 1) }
  ' "$ARGV_LOG"
}

# ---------------------------------------------------------------------------
# Case 1: AM_API_KEY set → Authorization header present in both calls
# ---------------------------------------------------------------------------
printf '\nCase 1: AM_API_KEY set → Bearer auth header on hook curls\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
export ATOMICMEMORY_API_KEY="am_live_secret"
am_load_env || { printf 'am_load_env failed\n' >&2; exit 1; }

reset_log
body='{"user_id":"u","conversation":"c","source_site":"claude-code","source_url":"atomicmemory://test","skip_extraction":true}'
am_post_quick_ingest "$body" >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer am_live_secret" && cond=true || cond=false
assert "ingest curl includes Authorization: Bearer <key>" "$cond"

reset_log
am_search_fast "what did we decide" 3 >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer am_live_secret" && cond=true || cond=false
assert "search curl includes Authorization: Bearer <key>" "$cond"

unset ATOMICMEMORY_API_KEY
unset ATOMICMEMORY_API_URL

# ---------------------------------------------------------------------------
# Case 2: AM_API_KEY unset → no Authorization header on either call
# ---------------------------------------------------------------------------
printf '\nCase 2: AM_API_KEY unset → no Authorization header\n'
am_load_env || { printf 'am_load_env failed\n' >&2; exit 1; }

reset_log
am_post_quick_ingest "$body" >/dev/null 2>&1 || true
grep -q '^Authorization:' "$ARGV_LOG" && cond=false || cond=true
assert "ingest curl has no Authorization header" "$cond"

reset_log
am_search_fast "what did we decide" 3 >/dev/null 2>&1 || true
grep -q '^Authorization:' "$ARGV_LOG" && cond=false || cond=true
assert "search curl has no Authorization header" "$cond"

# ---------------------------------------------------------------------------
# Case 3: AM_API_URL override propagates to the curl call
# ---------------------------------------------------------------------------
printf '\nCase 3: AM_API_URL override propagates to the wire\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
am_load_env || { printf 'am_load_env failed\n' >&2; exit 1; }

reset_log
am_post_quick_ingest "$body" >/dev/null 2>&1 || true
grep -qx 'https://memory.example.com/v1/memories/ingest/quick' "$ARGV_LOG" && cond=true || cond=false
assert "ingest URL uses override host" "$cond"

reset_log
am_search_fast "q" 3 >/dev/null 2>&1 || true
grep -qx 'https://memory.example.com/v1/memories/search/fast' "$ARGV_LOG" && cond=true || cond=false
assert "search URL uses override host" "$cond"

unset ATOMICMEMORY_API_URL

printf '\n--- %d passed, %d failed ---\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
