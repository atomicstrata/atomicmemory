#!/usr/bin/env bash
# macOS embedded runtime entrypoint for AtomicMemory DMG packaging.
#
# Lifecycle parity with scripts/docker-entrypoint.sh without gosu/docker.
# Intended to be invoked by AtomicMemory.app CoreRuntimeSupervisor or manually:
#
#   export RUNTIME_ROOT=/path/to/Resources/Runtime
#   export STATE_ROOT="$HOME/Library/Application Support/AtomicMemory"
#   export CORE_API_KEY=...
#   export OPENAI_API_KEY=...
#   ./macos-embedded-entrypoint.sh start
#
# Commands:
#   start   — init embedded Postgres (if needed), migrate, start Core (foreground)
#   migrate — run migrations only (Postgres must be reachable)
#   stop    — stop Core and embedded Postgres via validated PID file
#   help    — usage
#
# Bundle layout must include this script, lib/, atomicmemory-core, and postgres/.
# See docs/macos-embedded-runtime.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/macos-embedded-postgres.sh
source "$SCRIPT_DIR/lib/macos-embedded-postgres.sh"
# shellcheck source=lib/macos-embedded-lifecycle.sh
source "$SCRIPT_DIR/lib/macos-embedded-lifecycle.sh"

RUNTIME_ROOT="${RUNTIME_ROOT:-$SCRIPT_DIR}"
STATE_ROOT="${STATE_ROOT:-$HOME/Library/Application Support/AtomicMemory}"

CORE_BIN="${RUNTIME_ROOT}/atomicmemory-core"
PG_ROOT="${RUNTIME_ROOT}/postgres"
PG_BIN="${PG_ROOT}/bin"

EMBEDDED_POSTGRES_DATA_DIR="${EMBEDDED_POSTGRES_DATA_DIR:-$STATE_ROOT/postgres}"
EMBEDDED_POSTGRES_RUN_DIR="${EMBEDDED_POSTGRES_RUN_DIR:-$STATE_ROOT/postgres-run}"
EMBEDDED_POSTGRES_PORT="${EMBEDDED_POSTGRES_PORT:-54329}"
EMBEDDED_POSTGRES_USER="${EMBEDDED_POSTGRES_USER:-atomicmemory}"
EMBEDDED_POSTGRES_DB="${EMBEDDED_POSTGRES_DB:-atomicmemory}"

CORE_STATE_DIR="${CORE_STATE_DIR:-$STATE_ROOT/state}"
CORE_API_KEY_FILE="$CORE_STATE_DIR/core-api-key"
POSTGRES_PASSWORD_FILE="$CORE_STATE_DIR/postgres-password"
RUNTIME_PID_FILE="$CORE_STATE_DIR/runtime.pid"
LOCAL_STORAGE_KEY_HMAC_SECRET="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
LOG_DIR="${LOG_DIR:-$STATE_ROOT/logs}"

APP_PID=""
POSTGRES_STARTED=false
CLEANING_UP=false

log() {
  printf '[macos-embedded] %s\n' "$*" >&2
}

configure_locale() {
  # GUI-launched apps often inherit an empty/minimal locale; initdb requires a valid one.
  export LANG="${LANG:-en_US.UTF-8}"
  export LC_ALL="${LC_ALL:-en_US.UTF-8}"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|migrate|stop|help>

Environment:
  RUNTIME_ROOT              Bundle Resources/Runtime (default: this script's directory)
  STATE_ROOT                Application Support root (default: ~/Library/Application Support/AtomicMemory)
  DATABASE_URL              "embedded" or postgresql://... (default: embedded)
  CORE_API_KEY              API key (generated/persisted under STATE_ROOT/state if unset)
  STORAGE_KEY_HMAC_SECRET   HMAC secret (local default if unset)
  OPENAI_API_KEY            Required for lean embedding profile
  LISTEN_HOST               Core bind address (default: 127.0.0.1)
  EMBEDDED_POSTGRES_PORT    Loopback port (default: 54329)
EOF
}

require_runtime_layout() {
  if [[ ! -x "$CORE_BIN" ]]; then
    log "missing Core binary: $CORE_BIN"
    exit 1
  fi
  if [[ ! -x "$PG_BIN/postgres" ]]; then
    log "missing Postgres binary: $PG_BIN/postgres"
    exit 1
  fi
}

persist_core_api_key() {
  local key="$1"
  mkdir -p "$CORE_STATE_DIR"
  printf '%s\n' "$key" > "$CORE_API_KEY_FILE"
  chmod 600 "$CORE_API_KEY_FILE"
}

resolve_core_api_key() {
  if [[ -n "${CORE_API_KEY:-}" ]]; then
    persist_core_api_key "$CORE_API_KEY"
    export CORE_API_KEY
    log "CORE_API_KEY from environment (persisted)"
    return
  fi
  if [[ -s "$CORE_API_KEY_FILE" ]]; then
    CORE_API_KEY="$(tr -d '[:space:]' < "$CORE_API_KEY_FILE")"
    if [[ -n "$CORE_API_KEY" ]]; then
      export CORE_API_KEY
      log "CORE_API_KEY loaded from $CORE_API_KEY_FILE"
      return
    fi
  fi
  CORE_API_KEY="$(openssl rand -hex 32)"
  persist_core_api_key "$CORE_API_KEY"
  export CORE_API_KEY
  log "CORE_API_KEY generated and persisted"
}

reject_unsupported_storage() {
  if [[ "${RAW_STORAGE_MODE:-pointer_only}" = "managed_blob" \
    && "${RAW_STORAGE_PROVIDER:-local_fs}" != "local_fs" ]]; then
    log "lean profile requires RAW_STORAGE_PROVIDER=local_fs when RAW_STORAGE_MODE=managed_blob"
    exit 1
  fi
}

configure_local_defaults() {
  export RAW_STORAGE_DEPLOYMENT_ENV="${RAW_STORAGE_DEPLOYMENT_ENV:-local}"
  export PORT="${PORT:-17350}"
  export LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
  reject_unsupported_storage
  resolve_core_api_key
  if [[ -z "${STORAGE_KEY_HMAC_SECRET:-}" ]]; then
    export STORAGE_KEY_HMAC_SECRET="$LOCAL_STORAGE_KEY_HMAC_SECRET"
    log "STORAGE_KEY_HMAC_SECRET not set; using local default"
  fi
  export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-openai}"
  export EMBEDDING_DIMENSIONS="${EMBEDDING_DIMENSIONS:-1536}"
  if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    log "OPENAI_API_KEY is required for lean embedding profile"
    exit 1
  fi
}

run_migrations() {
  log "Running migrations..."
  "$CORE_BIN" migrate
}

start_core_foreground() {
  log "Starting AtomicMemory Core on ${LISTEN_HOST}:${PORT} ..."
  "$CORE_BIN" start >>"$LOG_DIR/core.log" 2>&1 &
  APP_PID="$!"
  write_runtime_pid
  wait "$APP_PID"
}

prepare_database() {
  if [[ "${DATABASE_URL:-embedded}" = "embedded" ]]; then
    start_embedded_postgres
    return
  fi
  log "Using external DATABASE_URL"
}

cmd_migrate() {
  require_runtime_layout
  configure_local_defaults
  prepare_database
  run_migrations
}

cmd_start() {
  require_runtime_layout
  configure_local_defaults
  mkdir -p "$LOG_DIR"
  prepare_database
  run_migrations
  start_core_foreground
}

main() {
  configure_locale
  local cmd="${1:-help}"
  case "$cmd" in
    start)
      install_lifecycle_traps
      cmd_start
      ;;
    migrate)
      install_lifecycle_traps
      cmd_migrate
      ;;
    stop) cmd_stop ;;
    help|-h|--help) usage ;;
    *)
      log "unknown command: $cmd"
      usage
      exit 1
      ;;
  esac
}

main "$@"
