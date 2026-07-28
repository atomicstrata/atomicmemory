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
LOCAL_DOCKER_STORAGE_KEY_HMAC_SECRET="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
CORE_STATE_DIR="${CORE_STATE_DIR:-/var/lib/atomicmemory/state}"
CORE_API_KEY_FILE="$CORE_STATE_DIR/core-api-key"

log() {
  printf '[entrypoint] %s\n' "$*"
}

is_hosted_deployment_env() {
  case "${1:-local}" in
    production|staging) return 0 ;;
    *) return 1 ;;
  esac
}

generate_core_api_key() {
  od -vN32 -An -tx1 /dev/urandom | tr -d ' \n'
}

persist_core_api_key() {
  local key="$1"
  mkdir -p "$CORE_STATE_DIR"
  printf '%s\n' "$key" > "$CORE_API_KEY_FILE"
  chmod 600 "$CORE_API_KEY_FILE"
}

resolve_core_api_key() {
  if is_hosted_deployment_env "${RAW_STORAGE_DEPLOYMENT_ENV:-local}"; then
    if [ -z "${CORE_API_KEY:-}" ]; then
      log "CORE_API_KEY is required when RAW_STORAGE_DEPLOYMENT_ENV=${RAW_STORAGE_DEPLOYMENT_ENV:-local}"
      exit 1
    fi
    export CORE_API_KEY
    log "CORE_API_KEY from environment (hosted — not persisted locally)"
    return
  fi

  if [ -n "${CORE_API_KEY:-}" ]; then
    persist_core_api_key "$CORE_API_KEY"
    export CORE_API_KEY
    log "CORE_API_KEY from environment and persisted to $CORE_API_KEY_FILE"
    return
  fi

  if [ -s "$CORE_API_KEY_FILE" ]; then
    CORE_API_KEY="$(tr -d '[:space:]' < "$CORE_API_KEY_FILE")"
    if [ -n "$CORE_API_KEY" ]; then
      export CORE_API_KEY
      log "CORE_API_KEY loaded from $CORE_API_KEY_FILE"
      return
    fi
  fi

  CORE_API_KEY="$(generate_core_api_key)"
  persist_core_api_key "$CORE_API_KEY"
  export CORE_API_KEY
  log "CORE_API_KEY generated and persisted to $CORE_API_KEY_FILE"
}

cloud_tier_api_url() {
  case "${1:-dev}" in
    dev) printf '%s' 'https://api.dev.atomicstrata.ai' ;;
    staging) printf '%s' 'https://api.staging.atomicstrata.ai' ;;
    production|prod) printf '%s' 'https://api.atomicstrata.ai' ;;
    *)
      log "Unknown CLOUD_ENV: ${1}"
      exit 1
      ;;
  esac
}

cloud_tier_memory_origin() {
  case "${1:-dev}" in
    dev) printf '%s' 'https://memory.dev.atomicstrata.ai' ;;
    staging) printf '%s' 'https://memory.staging.atomicstrata.ai' ;;
    production|prod) printf '%s' 'https://memory.atomicstrata.ai' ;;
    *)
      log "Unknown CLOUD_ENV: ${1}"
      exit 1
      ;;
  esac
}

# When running self-hosted Core for connected-local, apply tier defaults so
# operators only pass OPENAI_API_KEY + ATOMICMEMORY_API_KEY. The presence of
# ATOMICMEMORY_API_KEY is the single switch that turns connected-local on;
# CLOUD_PROJECT_ID is optional (Core trusts the token's project_id when unset).
apply_connected_local_defaults() {
  if is_hosted_deployment_env "${RAW_STORAGE_DEPLOYMENT_ENV:-local}"; then
    return
  fi

  if [ -z "${ATOMICMEMORY_API_KEY:-}" ]; then
    return
  fi

  local tier="${CLOUD_ENV:-dev}"
  local api_url memory_origin

  api_url="$(cloud_tier_api_url "$tier")"
  memory_origin="$(cloud_tier_memory_origin "$tier")"

  export CLOUD_TRACE_SYNC_ENABLED="${CLOUD_TRACE_SYNC_ENABLED:-true}"
  export ATOMICMEMORY_API_URL="${ATOMICMEMORY_API_URL:-$api_url}"

  export CLOUD_JWKS_URL="${CLOUD_JWKS_URL:-${api_url}/.well-known/atomic-core/jwks.json}"
  export CLOUD_JWT_ISSUER="${CLOUD_JWT_ISSUER:-$api_url}"
  export CLOUD_JWT_AUDIENCE="${CLOUD_JWT_AUDIENCE:-atomicmemory-core}"
  export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-$memory_origin}"
  export CLOUD_JWT_STATIC_KEY_FALLBACK="${CLOUD_JWT_STATIC_KEY_FALLBACK:-true}"
  if [ "$tier" = "dev" ]; then
    export CLOUD_JWT_LEGACY_DEFAULT_MEMORY_USER_ID="${CLOUD_JWT_LEGACY_DEFAULT_MEMORY_USER_ID:-default}"
  fi
  log "Connected-local defaults applied (CLOUD_ENV=$tier, api=$ATOMICMEMORY_API_URL)"
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

  apply_connected_local_defaults
  resolve_core_api_key

  if [ -z "${STORAGE_KEY_HMAC_SECRET:-}" ]; then
    if is_hosted_deployment_env "$deployment_env"; then
      log "STORAGE_KEY_HMAC_SECRET is required when RAW_STORAGE_DEPLOYMENT_ENV=$deployment_env"
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
