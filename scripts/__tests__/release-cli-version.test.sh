#!/usr/bin/env bash
#
# Regression tests for release-cli tag-to-version resolution in release-cli.yml.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/release-cli.yml"

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

printf '\nrelease-cli version resolution tests\n'

[ -f "$WORKFLOW" ] && assert "release-cli workflow exists" true \
  || assert "release-cli workflow exists" false

resolve_step_count="$(grep -c 'name: Resolve version' "$WORKFLOW" || true)"
[ "$resolve_step_count" -eq 2 ] && assert "workflow defines two Resolve version steps" true \
  || assert "workflow defines two Resolve version steps" false

cli_v_strip_count="$(grep -Fc 'v="${REF_NAME#cli-v}"' "$WORKFLOW" || true)"
[ "$cli_v_strip_count" -eq 2 ] && assert "both resolver blocks strip cli-v once" true \
  || assert "both resolver blocks strip cli-v once" false

v_v_strip_count="$(grep -Fc 'v="${v#v}"' "$WORKFLOW" || true)"
[ "$v_v_strip_count" -eq 0 ] && assert "workflow has no second v strip" true \
  || assert "workflow has no second v strip" false

printf '\nResults: %s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  exit 1
fi
