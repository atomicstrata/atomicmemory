#!/usr/bin/env bash
#
# Unit gate for `am_quick_ingest_body` in
# `plugins/claude-code/scripts/lib/atomicmemory.sh`.
#
# Asserts the JSON body shape `am_quick_ingest_body` produces for
# four input variants:
#   1. no metadata arg → 5-field body, no `metadata` key
#   2. literal '{}' as metadata → same as #1 (treat empty-object
#      as no-metadata so non-hook callers don't emit
#      `"metadata": {}` on the wire)
#   3. real metadata object → 6-field body with `metadata` deep-
#      equal to the input
#   4. malformed JSON → exits non-zero with a non-empty stderr
#      (project rule: no fallback values)
#
# Runs entirely in-process: no Docker, no curl, no network.
# The companion `metadata-roundtrip.sh` script is the optional
# HTTP smoke against a real core.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="$SCRIPT_DIR/../lib/atomicmemory.sh"

if [ ! -f "$LIB_PATH" ]; then
  printf 'fixture path missing: %s\n' "$LIB_PATH" >&2
  exit 1
fi

# Required by `am_quick_ingest_body`; value irrelevant for body-shape
# assertions. Set before sourcing so the source-time `am_load_env`
# checks (if any) don't bail.
export AM_SCOPE_USER="test-user-uuid"
export AM_API_URL="http://localhost:0"
export ATOMICMEMORY_PROVIDER="atomicmemory"
export ATOMICMEMORY_CAPTURE_LEVEL="balanced"

# shellcheck source=../lib/atomicmemory.sh
source "$LIB_PATH"

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

# ---------------------------------------------------------------------------
# Case 1 — no metadata arg → 5-field body, no `metadata` key
# ---------------------------------------------------------------------------
printf '\nCase 1: no metadata arg\n'
body1=$(am_quick_ingest_body "content_x" "https://example.com/y")
[ "$(printf '%s' "$body1" | jq -e 'has("metadata") | not' >/dev/null 2>&1 && echo true || echo false)" = "true" ] \
  && cond=true || cond=false
assert "no metadata key in body" "$cond"
[ "$(printf '%s' "$body1" | jq -e '.skip_extraction == true' >/dev/null 2>&1 && echo true || echo false)" = "true" ] \
  && cond=true || cond=false
assert "skip_extraction true" "$cond"
[ "$(printf '%s' "$body1" | jq 'keys | length' 2>/dev/null)" = "5" ] \
  && cond=true || cond=false
assert "exactly 5 keys" "$cond"

# ---------------------------------------------------------------------------
# Case 2 — '{}' literal → same as no metadata
# ---------------------------------------------------------------------------
printf '\nCase 2: literal empty object\n'
body2=$(am_quick_ingest_body "content_x" "https://example.com/y" '{}')
[ "$(printf '%s' "$body2" | jq -e 'has("metadata") | not' >/dev/null 2>&1 && echo true || echo false)" = "true" ] \
  && cond=true || cond=false
assert "no metadata key in body for '{}'" "$cond"
[ "$(printf '%s' "$body2" | jq 'keys | length' 2>/dev/null)" = "5" ] \
  && cond=true || cond=false
assert "exactly 5 keys for '{}'" "$cond"

# ---------------------------------------------------------------------------
# Case 3 — real metadata → 6-field body, metadata round-trips exactly
# ---------------------------------------------------------------------------
printf '\nCase 3: real metadata object\n'
md='{"event":"test","schema_version":1,"nested":{"ok":true}}'
body3=$(am_quick_ingest_body "content_x" "https://example.com/y" "$md")
[ "$(printf '%s' "$body3" | jq -e 'has("metadata")' >/dev/null 2>&1 && echo true || echo false)" = "true" ] \
  && cond=true || cond=false
assert "metadata key present" "$cond"
[ "$(printf '%s' "$body3" | jq 'keys | length' 2>/dev/null)" = "6" ] \
  && cond=true || cond=false
assert "exactly 6 keys" "$cond"
expected_metadata=$(printf '%s' "$md" | jq -c .)
actual_metadata=$(printf '%s' "$body3" | jq -c '.metadata')
[ "$actual_metadata" = "$expected_metadata" ] && cond=true || cond=false
assert "metadata deep-equals input" "$cond"

# ---------------------------------------------------------------------------
# Case 4 — malformed JSON → non-zero exit, non-empty stderr
# ---------------------------------------------------------------------------
printf '\nCase 4: malformed metadata JSON\n'
set +e
err4=$(am_quick_ingest_body "content_x" "https://example.com/y" '{not json' 2>&1 >/dev/null)
exit4=$?
set -e
[ "$exit4" -ne 0 ] && cond=true || cond=false
assert "exits non-zero on malformed JSON" "$cond"
[ -n "$err4" ] && cond=true || cond=false
assert "non-empty stderr message on malformed JSON" "$cond"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n--- %d passed, %d failed ---\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
