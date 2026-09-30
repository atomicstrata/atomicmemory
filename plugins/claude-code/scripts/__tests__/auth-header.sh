#!/usr/bin/env bash
#
# Unit gate for the Bearer auth header behavior of the hooks'
# direct-to-core HTTP calls in
# `plugins/claude-code/scripts/lib/atomicmemory.sh`.
#
# Shadows `curl` with a bash function that captures argv to a file,
# then exercises `am_post_quick_ingest` and `am_search_fast` with
# AM_API_KEY explicitly set, locally defaulted, and unset for remote URLs. Asserts:
#   1. With AM_API_KEY set, both curl invocations include
#      `-H Authorization: Bearer <key>`.
#   2. With the local quickstart URL and no explicit API key, both curl
#      invocations include the local quickstart Bearer key.
#   3. A remote URL without an API key fails configuration before any call.
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
      -w|--write-out) printf '%s' "${CURL_HTTP_CODE:-200}" ;;
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
export ATOMICMEMORY_API_KEY="am_live_secret"
am_load_env || { printf 'am_load_env failed\n' >&2; exit 1; }

reset_log
body='{"user_id":"u","conversation":"c","source_site":"claude-code","source_url":"atomicmemory://test","skip_extraction":true}'
am_post_quick_ingest "$body" >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer am_live_secret" && cond=true || cond=false
assert "ingest curl includes Authorization: Bearer <key>" "$cond"
grep -qx 'https://api.atomicstrata.ai/v1/memories/ingest/quick' "$ARGV_LOG" && cond=true || cond=false
assert "ingest curl uses default Cloud endpoint" "$cond"

reset_log
am_search_fast "what did we decide" 3 >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer am_live_secret" && cond=true || cond=false
assert "search curl includes Authorization: Bearer <key>" "$cond"
grep -qx 'https://api.atomicstrata.ai/v1/memories/search/fast' "$ARGV_LOG" && cond=true || cond=false
assert "search curl uses default Cloud endpoint" "$cond"

export CURL_HTTP_CODE=401
set +e
ingest_error=$(am_post_quick_ingest '{"conversation":"remember this"}' 2>&1)
ingest_exit_code=$?
search_error=$(am_search_fast "what did we decide" 3 2>&1)
search_exit_code=$?
set -e
[ "$ingest_exit_code" -ne 0 ] && cond=true || cond=false
assert "ingest rejects non-2xx responses" "$cond"
case "$ingest_error" in *"quick ingest failed with status 401"*) cond=true ;; *) cond=false ;; esac
assert "ingest surfaces the HTTP failure" "$cond"
[ "$search_exit_code" -ne 0 ] && cond=true || cond=false
assert "search rejects non-2xx responses" "$cond"
case "$search_error" in *"memory search failed with status 401"*) cond=true ;; *) cond=false ;; esac
assert "search surfaces the HTTP failure" "$cond"
unset CURL_HTTP_CODE

unset ATOMICMEMORY_API_KEY
unset ATOMICMEMORY_API_URL

# ---------------------------------------------------------------------------
# Case 2: explicit local quickstart URL → Authorization header present
# ---------------------------------------------------------------------------
printf '\nCase 2: explicit local quickstart → Bearer auth header on hook curls\n'
export ATOMICMEMORY_API_URL="http://127.0.0.1:17350"
am_load_env || { printf 'am_load_env failed\n' >&2; exit 1; }

reset_log
am_post_quick_ingest "$body" >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer local-dev-key" && cond=true || cond=false
assert "ingest curl includes local quickstart Authorization header" "$cond"

reset_log
am_search_fast "what did we decide" 3 >/dev/null 2>&1 || true
argv_contains_header "Authorization: Bearer local-dev-key" && cond=true || cond=false
assert "search curl includes local quickstart Authorization header" "$cond"
unset ATOMICMEMORY_API_URL

# ---------------------------------------------------------------------------
# Case 3: explicit Cloud URL without API key → fail closed
# ---------------------------------------------------------------------------
printf '\nCase 3: explicit Cloud URL without API key → fail closed\n'
export ATOMICMEMORY_API_URL="https://api.atomicstrata.ai"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && cond=true || cond=false
assert "Cloud config without a key is rejected" "$cond"
unset ATOMICMEMORY_API_URL

# ---------------------------------------------------------------------------
# Case 4: AM_API_URL override propagates to the curl call
# ---------------------------------------------------------------------------
printf '\nCase 4: AM_API_URL override propagates to the wire\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
export ATOMICMEMORY_API_KEY="am_live_secret"
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
unset ATOMICMEMORY_API_KEY

printf '\n--- %d passed, %d failed ---\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
