#!/usr/bin/env bash
# Default RUNTIME_ROOT is the script directory (bundle Runtime/).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=helpers.sh
source "$SCRIPT_DIR/helpers.sh"
trap cleanup_work EXIT

make_workspace
cp "$ENTRYPOINT" "$RUNTIME_ROOT/macos-embedded-entrypoint.sh"
cp -R "$CORE_SCRIPTS_DIR/lib" "$RUNTIME_ROOT/lib"
chmod +x "$RUNTIME_ROOT/macos-embedded-entrypoint.sh"

unset RUNTIME_ROOT
set +e
OPENAI_API_KEY=test-openai STATE_ROOT="$STATE_ROOT" \
  "$AM_WORK/Runtime/macos-embedded-entrypoint.sh" migrate >/tmp/am-runtime-root.out 2>&1
status=$?
set -e
assert_eq "unset RUNTIME_ROOT migrate" "0" "$status"
assert_not_contains "found bundled Core" "missing Core binary" "$(cat /tmp/am-runtime-root.out)"
rm -f /tmp/am-runtime-root.out
