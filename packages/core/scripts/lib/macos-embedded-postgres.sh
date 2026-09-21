#!/usr/bin/env bash
# Embedded Postgres helpers for the macOS DMG launcher.
#
# Owns initdb safety, SCRAM auth, quoted conf (paths may contain spaces),
# and DATABASE_URL construction. Sourced by macos-embedded-entrypoint.sh.

urlencode_component() {
  local raw="$1"
  local out="" c hex i
  for ((i = 0; i < ${#raw}; i++)); do
    c="${raw:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

pg_conf_quote() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

persist_postgres_password() {
  local password="$1"
  mkdir -p "$CORE_STATE_DIR"
  printf '%s\n' "$password" > "$POSTGRES_PASSWORD_FILE"
  chmod 600 "$POSTGRES_PASSWORD_FILE"
}

resolve_postgres_password() {
  if [[ -n "${EMBEDDED_POSTGRES_PASSWORD:-}" ]]; then
    persist_postgres_password "$EMBEDDED_POSTGRES_PASSWORD"
    return
  fi
  if [[ -s "$POSTGRES_PASSWORD_FILE" ]]; then
    EMBEDDED_POSTGRES_PASSWORD="$(tr -d '[:space:]' < "$POSTGRES_PASSWORD_FILE")"
    if [[ -n "$EMBEDDED_POSTGRES_PASSWORD" ]]; then
      return
    fi
  fi
  EMBEDDED_POSTGRES_PASSWORD="$(openssl rand -hex 32)"
  persist_postgres_password "$EMBEDDED_POSTGRES_PASSWORD"
}

write_embedded_postgres_conf() {
  local pgconf="$EMBEDDED_POSTGRES_DATA_DIR/postgresql.conf"
  local confdir="$EMBEDDED_POSTGRES_DATA_DIR/conf.d"
  mkdir -p "$confdir"
  if [[ -f "$pgconf" ]] && ! grep -q "^include_dir = 'conf.d'" "$pgconf"; then
    printf "\ninclude_dir = 'conf.d'\n" >> "$pgconf"
  fi
  cat > "$confdir/atomicmemory.conf" <<EOF
listen_addresses = '127.0.0.1'
port = ${EMBEDDED_POSTGRES_PORT}
unix_socket_directories = $(pg_conf_quote "$EMBEDDED_POSTGRES_RUN_DIR")
password_encryption = 'scram-sha-256'
EOF
}

write_embedded_pg_hba() {
  cat > "$EMBEDDED_POSTGRES_DATA_DIR/pg_hba.conf" <<'EOF'
# AtomicMemory embedded cluster — SCRAM only.
local   all   all                   scram-sha-256
host    all   all   127.0.0.1/32    scram-sha-256
host    all   all   ::1/128         scram-sha-256
EOF
}

cluster_uses_trust() {
  local hba="$EMBEDDED_POSTGRES_DATA_DIR/pg_hba.conf"
  [[ -f "$hba" ]] && grep -Eq '^[[:space:]]*(local|host)[[:space:]].*[[:space:]]trust([[:space:]]|$)' "$hba"
}

data_dir_is_nonempty() {
  local dir="$1"
  [[ -d "$dir" ]] && [[ -n "$(ls -A "$dir" 2>/dev/null)" ]]
}

refuse_unrecognized_data_dir() {
  log "refusing to initialize $EMBEDDED_POSTGRES_DATA_DIR: directory is nonempty and is not a Postgres cluster (missing PG_VERSION)"
  exit 1
}

init_new_cluster() {
  mkdir -p "$EMBEDDED_POSTGRES_DATA_DIR"
  chmod 700 "$EMBEDDED_POSTGRES_DATA_DIR"
  log "Initializing embedded Postgres at $EMBEDDED_POSTGRES_DATA_DIR"
  LC_ALL="$LC_ALL" LANG="$LANG" "$PG_BIN/initdb" \
    -D "$EMBEDDED_POSTGRES_DATA_DIR" \
    --username="$EMBEDDED_POSTGRES_USER" \
    --locale="$LC_ALL" \
    --encoding=UTF8 \
    --auth-local=scram-sha-256 \
    --auth-host=scram-sha-256 \
    --pwfile="$POSTGRES_PASSWORD_FILE"
  write_embedded_postgres_conf
  write_embedded_pg_hba
}

prepare_embedded_data_dir() {
  if [[ -s "$EMBEDDED_POSTGRES_DATA_DIR/PG_VERSION" ]]; then
    log "Using existing embedded Postgres data at $EMBEDDED_POSTGRES_DATA_DIR"
    write_embedded_postgres_conf
    return
  fi
  if data_dir_is_nonempty "$EMBEDDED_POSTGRES_DATA_DIR"; then
    refuse_unrecognized_data_dir
  fi
  init_new_cluster
}

run_psql() {
  PGPASSWORD="$EMBEDDED_POSTGRES_PASSWORD" "$PG_BIN/psql" \
    -h "$EMBEDDED_POSTGRES_RUN_DIR" \
    -p "$EMBEDDED_POSTGRES_PORT" \
    -U "$EMBEDDED_POSTGRES_USER" \
    "$@"
}

stop_postgres() {
  if [[ "${POSTGRES_STARTED:-false}" != "true" ]]; then
    return 0
  fi
  log "Stopping embedded Postgres..."
  "$PG_BIN/pg_ctl" -D "$EMBEDDED_POSTGRES_DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
  POSTGRES_STARTED=false
}

start_postgres_process() {
  log "Starting embedded Postgres on 127.0.0.1:$EMBEDDED_POSTGRES_PORT ..."
  "$PG_BIN/pg_ctl" \
    -D "$EMBEDDED_POSTGRES_DATA_DIR" \
    -l "$LOG_DIR/postgres.log" \
    -w \
    start
}

set_role_password() {
  local escaped="${EMBEDDED_POSTGRES_PASSWORD//\'/\'\'}"
  run_psql -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE \"$EMBEDDED_POSTGRES_USER\" PASSWORD '$escaped'" \
    >/dev/null
}

reload_postgres() {
  "$PG_BIN/pg_ctl" -D "$EMBEDDED_POSTGRES_DATA_DIR" reload >/dev/null
}

ensure_embedded_database() {
  if run_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$EMBEDDED_POSTGRES_DB'" | grep -qx 1; then
    return
  fi
  log "Creating database $EMBEDDED_POSTGRES_DB"
  run_psql -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$EMBEDDED_POSTGRES_DB\"" >/dev/null
}

ensure_vector_extension() {
  log "Ensuring pgvector extension"
  run_psql -d "$EMBEDDED_POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
}

export_embedded_database_url() {
  local encoded
  encoded="$(urlencode_component "$EMBEDDED_POSTGRES_PASSWORD")"
  export DATABASE_URL="postgresql://${EMBEDDED_POSTGRES_USER}:${encoded}@127.0.0.1:${EMBEDDED_POSTGRES_PORT}/${EMBEDDED_POSTGRES_DB}"
}

lock_down_cluster_auth() {
  set_role_password
  write_embedded_pg_hba
  reload_postgres
}

start_embedded_postgres() {
  configure_locale
  mkdir -p "$EMBEDDED_POSTGRES_RUN_DIR" "$LOG_DIR"
  export PATH="$PG_BIN:$PATH"
  export DYLD_LIBRARY_PATH="${PG_ROOT}/lib:${DYLD_LIBRARY_PATH:-}"
  resolve_postgres_password
  export PGPASSWORD="$EMBEDDED_POSTGRES_PASSWORD"
  prepare_embedded_data_dir
  start_postgres_process
  POSTGRES_STARTED=true
  lock_down_cluster_auth
  ensure_embedded_database
  ensure_vector_extension
  export_embedded_database_url
}
