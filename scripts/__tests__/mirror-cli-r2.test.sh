#!/usr/bin/env bash
#
# Regression tests for the R2 mirror workflow's release verification.
#
# The 0.2.0 release failed here: the verify step invoked `dist/install.sh`
# directly, but assets downloaded from a GitHub Release do not keep their
# executable bit, so the step exited 126 (Permission denied). Because verify
# runs before promotion, the mirror kept serving the previous version while
# the canonical Release was already published.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/mirror-cli-r2.yml"

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

printf '\nCase: mirror workflow exists\n'
[ -f "$WORKFLOW" ] && assert "mirror-cli-r2.yml is present" true || { assert "mirror-cli-r2.yml is present" false; exit 1; }

printf '\nCase: downloaded installer is invoked through a shell\n'
# Any bare `dist/install.sh` invocation (start of a command, not preceded by
# `sh `) reintroduces the exec-bit failure.
# Strip comment lines first: prose about the bug legitimately names the bare
# path, and matching it would make this guard fire on its own documentation.
if grep -vE '^[[:space:]]*#' "$WORKFLOW" \
  | grep -E '(^|[^[:alnum:]_/-])dist/install\.sh' \
  | grep -vqE 'sh dist/install\.sh|aws s3 cp dist/install\.sh'; then
  assert "verify step does not invoke dist/install.sh directly" false
else
  assert "verify step does not invoke dist/install.sh directly" true
fi
grep -q 'sh dist/install\.sh' "$WORKFLOW" \
  && assert "verify step runs the installer via sh" true \
  || assert "verify step runs the installer via sh" false

printf '\nCase: verification can reach the attestation API\n'
# The installer verifies the GitHub artifact attestation automatically only
# with authenticated `gh`. GH_TOKEN prevents the release gate from taking the
# checksum-only path when it validates the public mirror.
verify_env="$(awk '/- name: Verify pinned install/{f=1} f&&/^      - name:/&&!/Verify pinned install/{f=0} f' "$WORKFLOW")"
printf '%s' "$verify_env" | grep -q 'GH_TOKEN:' \
  && assert "verify step provides GH_TOKEN" true \
  || assert "verify step provides GH_TOKEN" false

printf '\nCase: promotion stays gated behind verification\n'
# Promotion must come after verify, so a build that cannot be verified never
# becomes the version the mirror advertises.
verify_line="$(grep -n 'Verify pinned install' "$WORKFLOW" | head -1 | cut -d: -f1)"
promote_line="$(grep -n 'Promote install.sh and version.json' "$WORKFLOW" | head -1 | cut -d: -f1)"
if [ -n "$verify_line" ] && [ -n "$promote_line" ] && [ "$promote_line" -gt "$verify_line" ]; then
  assert "promote step runs after the verify step" true
else
  assert "promote step runs after the verify step" false
fi

printf '\nResults: %d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ]
