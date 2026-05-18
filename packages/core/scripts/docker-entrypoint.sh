#!/usr/bin/env bash
# AtomicMemory container entrypoint.
#
# Supports two database modes:
# - DATABASE_URL unset or "embedded": start the bundled local Postgres/pgvector
#   instance and persist it under EMBEDDED_POSTGRES_DATA_DIR.
# - DATABASE_URL=postgresql://...: use the operator-provided external database.
set -euo pipefail

APP_PID=""
POSTGRES_STARTED=false
LOCAL_DOCKER_CORE_API_KEY="local-dev-key"
LOCAL_DOCKER_STORAGE_KEY_HMAC_SECRET="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

log() {
  printf '[entrypoint] %s\n' "$*"
}

stop_postgres() {
  if [ "$POSTGRES_STARTED" = "true" ]; then
    log "Stopping embedded Postgres..."
    gosu postgres pg_ctl \
      -D "$EMBEDDED_POSTGRES_DATA_DIR" \
      -m fast \
      -w \
      stop >/dev/null
  fi
}

shutdown() {
  log "Received shutdown signal"
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  stop_postgres
  exit 0
}

trap shutdown SIGTERM SIGINT

configure_local_defaults() {
  local deployment_env="${RAW_STORAGE_DEPLOYMENT_ENV:-local}"
  export RAW_STORAGE_DEPLOYMENT_ENV="$deployment_env"

  if [ -z "${CORE_API_KEY:-}" ]; then
    if [ "$deployment_env" = "production" ]; then
      log "CORE_API_KEY is required when RAW_STORAGE_DEPLOYMENT_ENV=production"
      exit 1
    fi
    export CORE_API_KEY="$LOCAL_DOCKER_CORE_API_KEY"
    log "CORE_API_KEY not set; using local Docker default '$CORE_API_KEY'"
  fi

  if [ -z "${STORAGE_KEY_HMAC_SECRET:-}" ]; then
    if [ "$deployment_env" = "production" ]; then
      log "STORAGE_KEY_HMAC_SECRET is required when RAW_STORAGE_DEPLOYMENT_ENV=production"
      exit 1
    fi
    export STORAGE_KEY_HMAC_SECRET="$LOCAL_DOCKER_STORAGE_KEY_HMAC_SECRET"
    log "STORAGE_KEY_HMAC_SECRET not set; using local Docker default"
  fi
}

run_psql() {
  gosu postgres psql \
    -h "$EMBEDDED_POSTGRES_RUN_DIR" \
    -p "$EMBEDDED_POSTGRES_PORT" \
    -U "$EMBEDDED_POSTGRES_USER" \
    "$@"
}

start_embedded_postgres() {
  mkdir -p "$EMBEDDED_POSTGRES_DATA_DIR" "$EMBEDDED_POSTGRES_RUN_DIR"
  chown -R postgres:postgres "$EMBEDDED_POSTGRES_DATA_DIR" "$EMBEDDED_POSTGRES_RUN_DIR"
  chmod 700 "$EMBEDDED_POSTGRES_DATA_DIR"

  if [ ! -s "$EMBEDDED_POSTGRES_DATA_DIR/PG_VERSION" ]; then
    log "Initializing embedded Postgres at $EMBEDDED_POSTGRES_DATA_DIR"
    gosu postgres initdb \
      -D "$EMBEDDED_POSTGRES_DATA_DIR" \
      --username="$EMBEDDED_POSTGRES_USER" \
      --auth-local=trust \
      --auth-host=trust >/dev/null
  else
    log "Using existing embedded Postgres data at $EMBEDDED_POSTGRES_DATA_DIR"
  fi

  log "Starting embedded Postgres..."
  gosu postgres pg_ctl \
    -D "$EMBEDDED_POSTGRES_DATA_DIR" \
    -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=$EMBEDDED_POSTGRES_RUN_DIR -p $EMBEDDED_POSTGRES_PORT" \
    -w \
    start >/dev/null
  POSTGRES_STARTED=true

  if ! run_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$EMBEDDED_POSTGRES_DB'" | grep -qx 1; then
    log "Creating embedded database $EMBEDDED_POSTGRES_DB"
    run_psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$EMBEDDED_POSTGRES_DB\"" >/dev/null
  fi

  export DATABASE_URL="postgresql://${EMBEDDED_POSTGRES_USER}@127.0.0.1:${EMBEDDED_POSTGRES_PORT}/${EMBEDDED_POSTGRES_DB}"
}

run_migrations() {
  case "${ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP:-true}" in
    true|1|yes)
      ;;
    false|0|no)
      log "Skipping startup migrations because ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP=false"
      return
      ;;
    *)
      log "ATOMICMEMORY_RUN_MIGRATIONS_ON_STARTUP must be true or false"
      exit 1
      ;;
  esac

  local migrate_args=()
  if [ -n "${MIGRATION_LOCK_TIMEOUT_MS:-}" ]; then
    case "$MIGRATION_LOCK_TIMEOUT_MS" in
      ''|*[!0-9]*)
        log "MIGRATION_LOCK_TIMEOUT_MS must be a positive integer"
        exit 1
        ;;
    esac
    if [ "$MIGRATION_LOCK_TIMEOUT_MS" -le 0 ]; then
      log "MIGRATION_LOCK_TIMEOUT_MS must be a positive integer"
      exit 1
    fi
    migrate_args+=("--lock-timeout-ms=${MIGRATION_LOCK_TIMEOUT_MS}")
  fi

  log "Running migrations..."
  gosu appuser ./node_modules/.bin/tsx src/db/migrate.ts "${migrate_args[@]}"
}

configure_local_defaults

if [ "${DATABASE_URL:-embedded}" = "embedded" ]; then
  start_embedded_postgres
else
  log "Using external DATABASE_URL"
fi

run_migrations

log "Starting AtomicMemory Core..."
gosu appuser "$@" &
APP_PID="$!"
set +e
wait "$APP_PID"
APP_STATUS="$?"
set -e
stop_postgres
exit "$APP_STATUS"
