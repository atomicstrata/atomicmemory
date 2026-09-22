#!/usr/bin/env bash
# Shared fixtures for macOS embedded launcher tests.

SCRIPT_TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SCRIPTS_DIR="$(cd "$SCRIPT_TESTS_DIR/.." && pwd)"
ENTRYPOINT="$CORE_SCRIPTS_DIR/macos-embedded-entrypoint.sh"

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL %s: expected %q got %q\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

assert_file() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    printf 'FAIL %s: missing %s\n' "$name" "$path" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL %s: missing %q\n' "$name" "$needle" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL %s: unexpectedly found %q\n' "$name" "$needle" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

install_stubs() {
  local bin="$RUNTIME_ROOT/postgres/bin"
  mkdir -p "$bin"
  cp "$SCRIPT_TESTS_DIR/stubs/initdb" "$bin/initdb"
  cp "$SCRIPT_TESTS_DIR/stubs/pg_ctl" "$bin/pg_ctl"
  cp "$SCRIPT_TESTS_DIR/stubs/psql" "$bin/psql"
  cp "$SCRIPT_TESTS_DIR/stubs/postgres" "$bin/postgres"
  cp "$SCRIPT_TESTS_DIR/stubs/atomicmemory-core" "$RUNTIME_ROOT/atomicmemory-core"
  chmod +x "$bin/initdb" "$bin/pg_ctl" "$bin/psql" "$bin/postgres" "$RUNTIME_ROOT/atomicmemory-core"
}

make_workspace() {
  AM_WORK="$(mktemp -d "${TMPDIR:-/tmp}/am-embed.XXXXXX")"
  export AM_WORK
  export STATE_ROOT="$AM_WORK/Application Support/AtomicMemory"
  export RUNTIME_ROOT="$AM_WORK/Runtime"
  export AM_STUB_DIR="$AM_WORK/stub-logs"
  mkdir -p "$RUNTIME_ROOT/postgres/bin" "$AM_STUB_DIR" "$STATE_ROOT"
  export AM_STUB_INITDB_ARGS="$AM_STUB_DIR/initdb.args"
  export AM_STUB_PGCTL_LOG="$AM_STUB_DIR/pgctl.log"
  export AM_STUB_PGCTL_STOPS="$AM_STUB_DIR/pgctl.stops"
  export AM_STUB_PGCTL_STARTS="$AM_STUB_DIR/pgctl.starts"
  : > "$AM_STUB_PGCTL_LOG"
  : > "$AM_STUB_PGCTL_STOPS"
  : > "$AM_STUB_PGCTL_STARTS"
  install_stubs
}

run_entry() {
  OPENAI_API_KEY="${OPENAI_API_KEY:-test-openai}" \
    RUNTIME_ROOT="$RUNTIME_ROOT" \
    STATE_ROOT="$STATE_ROOT" \
    "$ENTRYPOINT" "$@"
}

wait_for_file() {
  local path="$1"
  local i
  for i in $(seq 1 80); do
    if [[ -f "$path" ]]; then
      return 0
    fi
    sleep 0.05
  done
  printf 'FAIL timeout waiting for %s\n' "$path" >&2
  exit 1
}

cleanup_work() {
  if [[ -n "${AM_WORK:-}" && -d "$AM_WORK" ]]; then
    rm -rf "$AM_WORK"
  fi
}
