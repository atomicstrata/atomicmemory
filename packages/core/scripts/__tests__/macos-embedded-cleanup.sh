#!/usr/bin/env bash
# EXIT cleanup must stop owned Postgres after Core or migrate exits.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
run_entry migrate
assert_eq "migrate stops postgres once" "1" "$(wc -l < "$AM_STUB_PGCTL_STOPS" | tr -d ' ')"

: > "$AM_STUB_PGCTL_STOPS"
export AM_CORE_STUB_EXIT=23
set +e
run_entry start >/dev/null 2>&1
status=$?
set -e
assert_eq "start preserves Core exit" "23" "$status"
assert_eq "nonzero Core stops postgres" "1" "$(wc -l < "$AM_STUB_PGCTL_STOPS" | tr -d ' ')"

: > "$AM_STUB_PGCTL_STARTS"
: > "$AM_STUB_PGCTL_STOPS"
unset AM_CORE_STUB_EXIT
export AM_CORE_STUB_EXIT=0
run_entry start
assert_eq "restart can start postgres" "1" "$(wc -l < "$AM_STUB_PGCTL_STARTS" | tr -d ' ')"
