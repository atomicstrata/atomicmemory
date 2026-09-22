#!/usr/bin/env bash
# Embedded initdb must use SCRAM and persist a private password.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
run_entry migrate

initdb_args="$(cat "$AM_STUB_INITDB_ARGS")"
assert_contains "scram local" "--auth-local=scram-sha-256" "$initdb_args"
assert_contains "scram host" "--auth-host=scram-sha-256" "$initdb_args"
assert_not_contains "no local trust" "--auth-local=trust" "$initdb_args"
assert_not_contains "no host trust" "--auth-host=trust" "$initdb_args"

pw_file="$STATE_ROOT/state/postgres-password"
assert_file "password persisted" "$pw_file"
assert_eq "password file mode" "600" "$(stat -c '%a' "$pw_file" 2>/dev/null || stat -f '%OLp' "$pw_file")"

hba="$(cat "$STATE_ROOT/postgres/pg_hba.conf")"
assert_contains "scram hba" "scram-sha-256" "$hba"
assert_not_contains "no trust leftover" "trust" "$hba"

set +e
"$RUNTIME_ROOT/postgres/bin/psql" -w -d postgres >/dev/null 2>&1
psql_status=$?
set -e
assert_eq "passwordless psql rejected" "2" "$psql_status"
