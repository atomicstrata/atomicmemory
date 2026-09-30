#!/usr/bin/env bash
#
# Unit gate for `am_load_env` defaults in
# `plugins/claude-code/scripts/lib/atomicmemory.sh`.
#
# Locks the three-step URL resolution contract:
#   - ATOMICMEMORY_API_URL wins when set
#   - else Cloud when ATOMICMEMORY_API_KEY is set
#   - else local Core at http://127.0.0.1:17350
#   - ATOMICMEMORY_CAPTURE_LEVEL defaults to "balanced"
#   - ATOMICMEMORY_PROVIDER defaults to "atomicmemory"
#   - Cloud requires ATOMICMEMORY_API_KEY
#   - local Core keeps the "local-dev-key" convenience default
#   - ATOMICMEMORY_SCOPE_USER is auto-derived from the OS user
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
ERROR_LOG="$(mktemp)"
trap 'rm -f "$ERROR_LOG"' EXIT

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

printf '\nCase: unset URL and key default to local Core\n'
set +e
am_load_env 2>"$ERROR_LOG"
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 without URL or key" "$cond"
[ "$AM_PROVIDER" = "atomicmemory" ] && cond=true || cond=false
assert "AM_PROVIDER defaults to atomicmemory" "$cond"
[ "$AM_CAPTURE_LEVEL" = "balanced" ] && cond=true || cond=false
assert "AM_CAPTURE_LEVEL defaults to balanced (matches docs)" "$cond"
[ "$AM_API_URL" = "http://127.0.0.1:17350" ] && cond=true || cond=false
assert "AM_API_URL defaults to local Core" "$cond"
[ "$AM_API_KEY" = "local-dev-key" ] && cond=true || cond=false
assert "local Core receives local-dev-key" "$cond"
[ -n "$AM_SCOPE_USER" ] && cond=true || cond=false
assert "AM_SCOPE_USER auto-derives a non-empty value" "$cond"

printf '\nCase: API key alone defaults to Cloud\n'
export ATOMICMEMORY_API_KEY="am_live_test"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 with Cloud API key" "$cond"
[ "$AM_API_URL" = "https://api.atomicstrata.ai" ] && cond=true || cond=false
assert "Cloud URL is selected when only a key is set" "$cond"
[ "$AM_API_KEY" = "am_live_test" ] && cond=true || cond=false
assert "AM_API_KEY exposed from ATOMICMEMORY_API_KEY" "$cond"
unset ATOMICMEMORY_API_KEY

printf '\nCase: explicit URL wins over the key-based Cloud default\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
export ATOMICMEMORY_API_KEY="am_live_test"
am_load_env
[ "$AM_API_URL" = "https://memory.example.com" ] && cond=true || cond=false
assert "explicit URL is preserved" "$cond"
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: explicit Cloud URL requires a project API key\n'
export ATOMICMEMORY_API_URL="https://api.atomicstrata.ai"
set +e
am_load_env 2>"$ERROR_LOG"
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && cond=true || cond=false
assert "missing Cloud key fails closed" "$cond"
grep -q 'ATOMICMEMORY_API_KEY is required' "$ERROR_LOG" && cond=true || cond=false
assert "missing Cloud key prints a clear error" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: equivalent Cloud origins still require a project API key\n'
for cloud_url in "https://API.atomicstrata.ai" "https://api.atomicstrata.ai:443/v1" "https://api.atomicstrata.ai:0443/v1" "https://api.dev.atomicstrata.ai" "https://api.staging.atomicstrata.ai" "https://%61pi.atomicstrata.ai" "https://api%2eatomicstrata.ai" "https://api.atomicstrata.ai%2e" "https://api。atomicstrata。ai" "https://api．atomicstrata．ai" "https://api｡atomicstrata｡ai" "https://ａｐｉ.atomicstrata.ai" "https://ⓐⓟⓘ.atomicstrata.ai"; do
  export ATOMICMEMORY_API_URL="$cloud_url"
  set +e
  am_load_env 2>"$ERROR_LOG"
  exit_code=$?
  set -e
  [ "$exit_code" -ne 0 ] && cond=true || cond=false
  assert "$cloud_url fails closed without a key" "$cond"
done
unset ATOMICMEMORY_API_URL

printf '\nCase: missing Cloud key error points local Core users at the local URL\n'
export ATOMICMEMORY_API_URL="https://api.atomicstrata.ai"
set +e
am_load_env 2>"$ERROR_LOG"
set -e
grep -q 'ATOMICMEMORY_API_URL=http://127.0.0.1:17350' "$ERROR_LOG" && cond=true || cond=false
assert "missing Cloud key error includes the local Core hint" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: the local Core key is refused for Cloud origins\n'
for local_key in "local-dev-key" "  local-dev-key  "; do
  for cloud_url in "" "https://api.atomicstrata.ai" "https://API.atomicstrata.ai:443" "https://api.dev.atomicstrata.ai" "https://api.staging.atomicstrata.ai"; do
    if [ -n "$cloud_url" ]; then export ATOMICMEMORY_API_URL="$cloud_url"; else unset ATOMICMEMORY_API_URL; fi
    export ATOMICMEMORY_API_KEY="$local_key"
    set +e
    am_load_env 2>"$ERROR_LOG"
    exit_code=$?
    set -e
    [ "$exit_code" -ne 0 ] && grep -q 'local Core key' "$ERROR_LOG" && grep -q 'ATOMICMEMORY_API_URL=http://127.0.0.1:17350' "$ERROR_LOG" && cond=true || cond=false
    assert "'$local_key' rejected for '${cloud_url:-default}'" "$cond"
  done
done
export ATOMICMEMORY_API_URL="http://127.0.0.1:17350"
export ATOMICMEMORY_API_KEY="local-dev-key"
am_load_env && [ "$AM_API_KEY" = "local-dev-key" ] && cond=true || cond=false
assert "explicit local-dev-key still works for local Core" "$cond"
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: plain http to a Cloud hostname fails closed\n'
for insecure_url in "http://api.atomicstrata.ai" "HTTP://API.atomicstrata.ai:80/v1" "http://api.dev.atomicstrata.ai:8080" "http://api.staging.atomicstrata.ai%2e"; do
  export ATOMICMEMORY_API_URL="$insecure_url"
  export ATOMICMEMORY_API_KEY="amc_cloud_test"
  set +e
  am_load_env 2>"$ERROR_LOG"
  exit_code=$?
  set -e
  [ "$exit_code" -ne 0 ] && grep -q 'must use https' "$ERROR_LOG" && cond=true || cond=false
  assert "$insecure_url is refused" "$cond"
done
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: curl-compatible backslash URLs fail closed\n'
export ATOMICMEMORY_API_URL='https://evil.test\@api.atomicstrata.ai'
set +e
am_load_env 2>"$ERROR_LOG"
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && cond=true || cond=false
assert "backslash URL is rejected before curl" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: Cloud API keys are normalized before validation\n'
export ATOMICMEMORY_API_KEY='   '
set +e
am_load_env 2>"$ERROR_LOG"
exit_code=$?
set -e
# Whitespace-only key is treated as unset → local Core default.
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "whitespace-only key falls back to local Core" "$cond"
[ "$AM_API_URL" = "http://127.0.0.1:17350" ] && cond=true || cond=false
assert "whitespace-only key does not select Cloud" "$cond"
export ATOMICMEMORY_API_KEY='  amc_padded_test  '
am_load_env
[ "$AM_API_KEY" = "amc_padded_test" ] && cond=true || cond=false
assert "surrounding Cloud key whitespace is stripped" "$cond"
[ "$AM_API_URL" = "https://api.atomicstrata.ai" ] && cond=true || cond=false
assert "padded Cloud key selects Cloud URL" "$cond"
unset ATOMICMEMORY_API_KEY

printf '\nCase: Cloud configuration errors do not expose URL credentials\n'
export ATOMICMEMORY_API_URL='https://user:password@api.atomicstrata.ai'
set +e
am_load_env 2>"$ERROR_LOG"
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && ! grep -q 'password' "$ERROR_LOG" && cond=true || cond=false
assert "Cloud error omits URL credentials" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: whitespace-only API URL uses the Cloud default when a key is set\n'
export ATOMICMEMORY_API_URL='   '
export ATOMICMEMORY_API_KEY='amc_cloud_test'
am_load_env
[ "$AM_API_URL" = "https://api.atomicstrata.ai" ] && cond=true || cond=false
assert "blank URL normalizes to the Cloud default with a key" "$cond"
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: explicit local Core keeps its development-key convenience\n'
export ATOMICMEMORY_API_URL="http://127.0.0.1:17350"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 for explicit local Core" "$cond"
[ "$AM_API_KEY" = "local-dev-key" ] && cond=true || cond=false
assert "local Core receives local-dev-key" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: equivalent local origins keep the development key\n'
for local_url in "HTTP://LOCALHOST:17350" "http://localhost:017350"; do
  export ATOMICMEMORY_API_URL="$local_url"
  am_load_env
  [ "$AM_API_KEY" = "local-dev-key" ] && cond=true || cond=false
  assert "$local_url receives local-dev-key" "$cond"
done
unset ATOMICMEMORY_API_URL

printf '\nCase: custom deployment does not receive a synthesized key\n'
export ATOMICMEMORY_API_URL="https://memory.example.com"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "custom deployment may define its own auth policy" "$cond"
[ -z "$AM_API_KEY" ] && cond=true || cond=false
assert "AM_API_KEY remains empty for custom deployment" "$cond"
unset ATOMICMEMORY_API_URL

printf '\nCase: ATOMICMEMORY_API_URL trailing slash is stripped\n'
export ATOMICMEMORY_API_URL="https://memory.example.com/"
export ATOMICMEMORY_API_KEY="am_live_test"
set +e
am_load_env
set -e
[ "$AM_API_URL" = "https://memory.example.com" ] && cond=true || cond=false
assert "trailing slash stripped from API_URL" "$cond"
unset ATOMICMEMORY_API_URL
unset ATOMICMEMORY_API_KEY

printf '\nCase: explicit ATOMICMEMORY_CAPTURE_LEVEL overrides default\n'
export ATOMICMEMORY_CAPTURE_LEVEL="full"
export ATOMICMEMORY_API_KEY="am_live_test"
set +e
am_load_env
exit_code=$?
set -e
[ "$exit_code" -eq 0 ] && cond=true || cond=false
assert "exit 0 with explicit capture level" "$cond"
[ "$AM_CAPTURE_LEVEL" = "full" ] && cond=true || cond=false
assert "explicit value wins over default" "$cond"
unset ATOMICMEMORY_CAPTURE_LEVEL
unset ATOMICMEMORY_API_KEY

printf '\nCase: invalid ATOMICMEMORY_CAPTURE_LEVEL still rejected\n'
export ATOMICMEMORY_CAPTURE_LEVEL="nonsense"
export ATOMICMEMORY_API_KEY="am_live_test"
set +e
am_load_env 2>/dev/null
exit_code=$?
set -e
[ "$exit_code" -ne 0 ] && cond=true || cond=false
assert "exit non-zero on bogus capture level" "$cond"
unset ATOMICMEMORY_CAPTURE_LEVEL
unset ATOMICMEMORY_API_KEY

printf '\n--- %d passed, %d failed ---\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
