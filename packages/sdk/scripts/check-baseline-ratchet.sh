#!/usr/bin/env bash
# Enforces monotonic improvement on fallow baselines: CI fails if a PR
# grows .fallow/health-baseline.json or .fallow/dupes-baseline.json
# beyond what's on the base branch. Refactors that shrink the baseline
# are celebrated; regressions are blocked.
#
# Runs in CI after the fallow audit step. Requires `jq` and a full
# git history (fetch-depth: 0 in the workflow's checkout step).
set -euo pipefail

BASE_REF="${1:-origin/main}"

check_baseline() {
  local file="$1"
  local json_path="$2"
  local label="$3"

  if [ ! -f "$file" ]; then
    echo "$label: baseline missing at $file; skipping"
    return 0
  fi

  # If the baseline file is brand new on this PR (not tracked on the base
  # branch), there's nothing to ratchet against — the PR IS the floor.
  if ! git cat-file -e "$BASE_REF:$file" 2>/dev/null; then
    echo "$label: new baseline on this PR; skipping ratchet check"
    return 0
  fi

  local base_count head_count
  base_count=$(git show "$BASE_REF:$file" | jq "$json_path | length")
  head_count=$(jq "$json_path | length" "$file")

  if [ "$head_count" -gt "$base_count" ]; then
    echo "::error file=$file::baseline grew from $base_count to $head_count entries. Baselines ratchet: refactor the flagged code and regenerate the baseline, do not add new entries."
    return 1
  fi

  local delta=$((base_count - head_count))
  if [ "$delta" -gt 0 ]; then
    echo "$label: $base_count -> $head_count (-$delta) ✓ shrunk"
  else
    echo "$label: $base_count -> $head_count (unchanged)"
  fi
}

fail=0
check_baseline .fallow/health-baseline.json '.findings'       health || fail=1
check_baseline .fallow/dupes-baseline.json  '.clone_groups'   dupes  || fail=1
exit "$fail"
