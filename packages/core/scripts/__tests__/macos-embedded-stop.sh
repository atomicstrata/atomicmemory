#!/usr/bin/env bash
# stop must terminate a running Core process via the PID file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
export AM_CORE_STUB_SLEEP=1
run_entry start >/dev/null 2>&1 &
launcher_pid=$!
wait_for_file "$STATE_ROOT/state/runtime.pid"

core_pid="$(awk -F= '/^core_pid=/{print $2}' "$STATE_ROOT/state/runtime.pid")"
assert_eq "core still running before stop" "0" "$(kill -0 "$core_pid" && echo 0 || echo 1)"

run_entry stop
set +e
kill -0 "$core_pid" 2>/dev/null
core_alive=$?
kill -0 "$launcher_pid" 2>/dev/null
launcher_alive=$?
set -e
assert_eq "core terminated" "1" "$core_alive"
assert_eq "launcher terminated" "1" "$launcher_alive"
assert_eq "postgres stopped" "1" "$(wc -l < "$AM_STUB_PGCTL_STOPS" | tr -d ' ')"
