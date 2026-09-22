#!/usr/bin/env bash
# Assemble a relocatable Postgres 17 + pgvector tree for macOS DMG embedding.
#
# Writes:
#   dist-bin/postgres/   (staging tree)
#   dist-bin/atomicmemory-postgres-pgvector-darwin-arm64.tar.gz
#
# Prerequisites:
#   POSTGRES_SOURCE_PREFIX — root containing bin/, lib/, share/ (e.g. prepared PG17 build)
#   PGVECTOR_LIB_DIR (optional) — directory with vector.dylib for PG17
#
# See docs/darwin-pgvector-pack.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_DIR/dist-bin}"
STAGING="$OUTPUT_DIR/postgres"
ARCH="${ARCH:-$(uname -m)}"
TARBALL="$OUTPUT_DIR/atomicmemory-postgres-pgvector-darwin-${ARCH}.tar.gz"

log() {
  printf '[package-darwin-pgvector] %s\n' "$*" >&2
}

require_darwin() {
  if [[ "${AM_PACKAGE_ALLOW_NON_DARWIN:-}" = "1" ]]; then
    return 0
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    log "this script must run on macOS"
    exit 1
  fi
}

require_source_tree() {
  if [[ -z "${POSTGRES_SOURCE_PREFIX:-}" ]]; then
    log "POSTGRES_SOURCE_PREFIX is required (see docs/darwin-pgvector-pack.md)"
    exit 1
  fi
  local sub
  for sub in bin lib share; do
    if [[ ! -d "$POSTGRES_SOURCE_PREFIX/$sub" ]]; then
      log "missing $POSTGRES_SOURCE_PREFIX/$sub"
      exit 1
    fi
  done
}

require_file() {
  if [[ ! -e "$1" ]]; then
    log "missing required file: $1"
    exit 1
  fi
}

copy_pgvector_extras() {
  if [[ -z "${PGVECTOR_LIB_DIR:-}" ]]; then
    return 0
  fi
  if [[ ! -d "$PGVECTOR_LIB_DIR" ]]; then
    log "PGVECTOR_LIB_DIR is not a directory: $PGVECTOR_LIB_DIR"
    exit 1
  fi
  log "copying pgvector libs from $PGVECTOR_LIB_DIR"
  mkdir -p "$STAGING/lib"
  cp -R "$PGVECTOR_LIB_DIR/." "$STAGING/lib/"
  if [[ -n "${PGVECTOR_SHARE_DIR:-}" ]]; then
    if [[ ! -d "$PGVECTOR_SHARE_DIR" ]]; then
      log "PGVECTOR_SHARE_DIR is not a directory: $PGVECTOR_SHARE_DIR"
      exit 1
    fi
    mkdir -p "$STAGING/share/extension"
    cp -R "$PGVECTOR_SHARE_DIR/." "$STAGING/share/extension/"
  fi
}

validate_runtime_binaries() {
  local exe
  for exe in postgres pg_ctl initdb psql; do
    require_file "$STAGING/bin/$exe"
  done
}

validate_pgvector_files() {
  require_file "$STAGING/share/extension/vector.control"
  if ! compgen -G "$STAGING/share/extension/vector--*.sql" > /dev/null; then
    log "missing pgvector SQL files under $STAGING/share/extension"
    exit 1
  fi
  if [[ ! -e "$STAGING/lib/vector.dylib" && ! -e "$STAGING/lib/postgresql/vector.dylib" ]]; then
    log "missing pgvector library (vector.dylib)"
    exit 1
  fi
}

stage_postgres_tree() {
  log "staging from $POSTGRES_SOURCE_PREFIX -> $STAGING"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  cp -R "$POSTGRES_SOURCE_PREFIX/bin" "$STAGING/"
  cp -R "$POSTGRES_SOURCE_PREFIX/lib" "$STAGING/"
  cp -R "$POSTGRES_SOURCE_PREFIX/share" "$STAGING/"
  copy_pgvector_extras
  chmod -R u+w "$STAGING/bin"
  chmod +x "$STAGING/bin/"*
}

write_tarball() {
  log "creating $TARBALL"
  mkdir -p "$OUTPUT_DIR"
  tar -czf "$TARBALL" -C "$OUTPUT_DIR" postgres
  ls -lh "$TARBALL"
  log "done. Smoke test per docs/darwin-pgvector-pack.md"
}

require_darwin
require_source_tree
stage_postgres_tree
validate_runtime_binaries
validate_pgvector_files
write_tarball
