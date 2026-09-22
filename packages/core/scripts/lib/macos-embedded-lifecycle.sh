#!/usr/bin/env bash
# Process-lifecycle helpers for the macOS embedded launcher.
#
# Installs a shared EXIT cleanup that stops only processes this invocation
# started, and implements `stop` via a validated PID file so a second
# invocation can terminate Core and Postgres.

pid_is_numeric() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

pid_args_match() {
  local pid="$1"
  local needle="$2"
  local args
  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ -n "$args" && "$args" == *"$needle"* ]]
}

write_runtime_pid() {
  mkdir -p "$CORE_STATE_DIR"
  {
    printf 'launcher_pid=%s\n' "$$"
    printf 'core_pid=%s\n' "$APP_PID"
    printf 'core_bin=%s\n' "$CORE_BIN"
    printf 'port=%s\n' "${PORT:-}"
  } > "$RUNTIME_PID_FILE"
}

read_runtime_pid() {
  LAUNCHER_PID=""
  SAVED_CORE_PID=""
  SAVED_CORE_BIN=""
  SAVED_PORT=""
  [[ -f "$RUNTIME_PID_FILE" ]] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      launcher_pid) LAUNCHER_PID="$value" ;;
      core_pid) SAVED_CORE_PID="$value" ;;
      core_bin) SAVED_CORE_BIN="$value" ;;
      port) SAVED_PORT="$value" ;;
    esac
  done < "$RUNTIME_PID_FILE"
}

stop_owned_pid() {
  local pid="$1"
  local needle="$2"
  if ! pid_is_numeric "$pid"; then
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if ! pid_args_match "$pid" "$needle"; then
    return 1
  fi
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.05
  done
  kill -KILL "$pid" 2>/dev/null || true
  return 0
}

on_exit() {
  local status=$?
  if [[ "${CLEANING_UP:-false}" = "true" ]]; then
    return 0
  fi
  CLEANING_UP=true
  if [[ -n "${APP_PID:-}" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  stop_postgres
  rm -f "${RUNTIME_PID_FILE:-}"
  exit "$status"
}

on_signal() {
  log "Shutting down..."
  exit 0
}

install_lifecycle_traps() {
  CLEANING_UP=false
  trap on_exit EXIT
  trap on_signal SIGTERM SIGINT
}

stop_recorded_core() {
  if ! pid_is_numeric "${SAVED_CORE_PID:-}"; then
    return 0
  fi
  if ! kill -0 "$SAVED_CORE_PID" 2>/dev/null; then
    return 0
  fi
  if stop_owned_pid "$SAVED_CORE_PID" "atomicmemory-core"; then
    return 0
  fi
  log "refusing to signal unrecognized Core pid $SAVED_CORE_PID"
  return 1
}

stop_recorded_launcher() {
  if ! pid_is_numeric "${LAUNCHER_PID:-}"; then
    return 0
  fi
  if [[ "$LAUNCHER_PID" = "$$" ]]; then
    return 0
  fi
  if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    return 0
  fi
  if stop_owned_pid "$LAUNCHER_PID" "macos-embedded-entrypoint"; then
    return 0
  fi
  log "refusing to signal unrecognized launcher pid $LAUNCHER_PID"
  return 1
}

stop_postmaster_if_present() {
  if [[ -f "$EMBEDDED_POSTGRES_DATA_DIR/postmaster.pid" ]]; then
    POSTGRES_STARTED=true
    stop_postgres
  fi
}

cmd_stop() {
  trap - EXIT
  local failed=false
  if read_runtime_pid; then
    stop_recorded_core || failed=true
    stop_recorded_launcher || failed=true
    rm -f "$RUNTIME_PID_FILE"
  fi
  stop_postmaster_if_present
  if [[ "$failed" = "true" ]]; then
    log "stop failed: process identity could not be validated"
    exit 1
  fi
  log "Stopped"
}
