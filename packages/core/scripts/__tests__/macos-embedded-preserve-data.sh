#!/usr/bin/env bash
# Nonempty non-cluster data dirs must be preserved.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
mkdir -p "$STATE_ROOT/postgres"
printf 'keep\n' > "$STATE_ROOT/postgres/important.txt"

set +e
run_entry migrate >/tmp/am-preserve.out 2>&1
status=$?
set -e

assert_eq "nonzero for unrecognized data dir" "1" "$status"
assert_file "important.txt preserved" "$STATE_ROOT/postgres/important.txt"
assert_eq "important.txt contents" "keep" "$(tr -d '\n' < "$STATE_ROOT/postgres/important.txt")"
assert_contains "actionable error" "missing PG_VERSION" "$(cat /tmp/am-preserve.out)"
rm -f /tmp/am-preserve.out
