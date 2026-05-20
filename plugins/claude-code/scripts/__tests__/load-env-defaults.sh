#!/usr/bin/env bash
#
# Unit gate for `am_load_env` defaults in
# `plugins/claude-code/scripts/lib/atomicmemory.sh`.
#
# Locks the documented local-mode contract from
# https://docs.atomicstrata.ai/integrations/coding-agents/claude-code/local:
#   - ATOMICMEMORY_CAPTURE_LEVEL defaults to "balanced"
#   - ATOMICMEMORY_PROVIDER defaults to "atomicmemory"
#   - ATOMICMEMORY_API_URL defaults to "http://127.0.0.1:17350"
#   - ATOMICMEMORY_API_KEY defaults to "local-dev-key" only for the local URL
#   - ATOMICMEMORY_SCOPE_USER is auto-derived from the OS user
# A fresh install with no ATOMICMEMORY_* host env vars set MUST succeed
# so PostCompact (and the rest of the lifecycle hooks) do not exit 1.
#
# Runs entirely in-process: no Docker, no curl, no network.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="$SCRIPT_DIR/../lib/atomicmemory.sh"

if [ ! -f "$LIB_PATH" ]; then
  printf 'fixture path missing: %s\n' "$LIB_PATH" >&2
  exit 1
fi

unset ATOMICMEMORY_PROVIDER
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY
unset ATOMICMEMORY_CAPTURE_LEVEL
unset ATOMICMEMORY_SCOPE_USER
unset ATOMICMEMORY_SCOPE_AGENT
unset ATOMICMEMORY_SCOPE_NAMESPACE
unset ATOMICMEMORY_SCOPE_THREAD
export USER="${USER:-test-user}"

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

printf '\nCase: am_load_env succeeds with no ATOMICMEMORY_* host vars\n'
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 on fresh-install env" "$cond"
[ "$AM_PROVIDER" = "atomicmemory" ] && cond=true || cond=false
assert "AM_PROVIDER defaults to atomicmemory" "$cond"
[ "$AM_CAPTURE_LEVEL" = "balanced" ] && cond=true || cond=false
assert "AM_CAPTURE_LEVEL defaults to balanced (matches docs)" "$cond"
[ "$AM_API_URL" = "http://127.0.0.1:17350" ] && cond=true || cond=false
assert "AM_API_URL defaults to local core URL" "$cond"
[ "$AM_API_KEY" = "local-dev-key" ] && cond=true || cond=false
assert "AM_API_KEY defaults to local quickstart key" "$cond"
[ -n "$AM_SCOPE_USER" ] && cond=true || cond=false
assert "AM_SCOPE_USER auto-derives a non-empty value" "$cond"

printf '\nCase: explicit ATOMICMEMORY_API_URL / API_KEY overrides for hosted mode\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
export ATOMICMEMORY_API_KEY="am_live_test"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 with explicit hosted overrides" "$cond"
[ "$AM_API_URL" = "https://memory.example.com" ] && cond=true || cond=false
assert "AM_API_URL honors ATOMICMEMORY_API_URL override" "$cond"
[ "$AM_API_KEY" = "am_live_test" ] && cond=true || cond=false
assert "AM_API_KEY exposed from ATOMICMEMORY_API_KEY" "$cond"
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: remote URL does not receive local default API key\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 with remote URL and no API key" "$cond"
[ -z "$AM_API_KEY" ] && cond=true || cond=false
assert "AM_API_KEY remains empty for remote URL" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: ATOMICMEMORY_API_URL trailing slash is stripped\n'
export ATOMICMEMORY_API_URL="https://memory.example.com/"
set +e
am_load_env
set -e
[ "$AM_API_URL" = "https://memory.example.com" ] && cond=true || cond=false
assert "trailing slash stripped from API_URL" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: explicit ATOMICMEMORY_CAPTURE_LEVEL overrides default\n'
export ATOMICMEMORY_CAPTURE_LEVEL="full"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 with explicit capture level" "$cond"
[ "$AM_CAPTURE_LEVEL" = "full" ] && cond=true || cond=false
assert "explicit value wins over default" "$cond"
unset ATOMICMEMORY_CAPTURE_LEVEL

printf '\nCase: invalid ATOMICMEMORY_CAPTURE_LEVEL still rejected\n'
export ATOMICMEMORY_CAPTURE_LEVEL="nonsense"
set +e
am_load_env 2>/dev/null
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && cond=true || cond=false
assert "exit non-zero on bogus capture level" "$cond"
unset ATOMICMEMORY_CAPTURE_LEVEL

printf '\n--- %d passed, %d failed ---\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
