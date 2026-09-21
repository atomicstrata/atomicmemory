#!/usr/bin/env bash
# Conf-file pg_ctl start must keep Application Support socket paths intact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
run_entry migrate

conf="$STATE_ROOT/postgres/conf.d/atomicmemory.conf"
assert_file "quoted socket conf" "$conf"
assert_contains "socket path with spaces" \
  "Application Support/AtomicMemory/postgres-run" "$(cat "$conf")"

pgctl_log="$(cat "$AM_STUB_PGCTL_LOG")"
assert_not_contains "no -o path interpolation" "-o" "$pgctl_log"
assert_not_contains "no split Support fragment" $'Support/state\n' "$pgctl_log"
