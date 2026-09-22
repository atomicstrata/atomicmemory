#!/usr/bin/env bash
# Darwin pack validation and archive-name contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACK="$SCRIPT_DIR/../package-darwin-pgvector.sh"

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL %s: expected %q got %q\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'PASS %s\n' "$name"
}

work="$(mktemp -d "${TMPDIR:-/tmp}/am-pgpack.XXXXXX")"
trap 'rm -rf "$work"' EXIT
export AM_PACKAGE_ALLOW_NON_DARWIN=1
export ARCH=arm64

empty="$work/empty"
mkdir -p "$empty/bin" "$empty/lib" "$empty/share"
set +e
POSTGRES_SOURCE_PREFIX="$empty" OUTPUT_DIR="$work/out-empty" "$PACK" >/dev/null 2>&1
empty_status=$?
set -e
assert_eq "empty prefix fails" "1" "$empty_status"

src="$work/src"
mkdir -p "$src/bin" "$src/lib" "$src/share/extension"
printf 'x\n' > "$src/bin/postgres"
printf 'x\n' > "$src/bin/pg_ctl"
printf 'x\n' > "$src/bin/initdb"
printf 'x\n' > "$src/bin/psql"
printf 'x\n' > "$src/lib/vector.dylib"
printf 'x\n' > "$src/share/extension/vector.control"
printf 'x\n' > "$src/share/extension/vector--0.8.0.sql"

POSTGRES_SOURCE_PREFIX="$src" OUTPUT_DIR="$work/out" "$PACK" >/dev/null
tarball="$work/out/atomicmemory-postgres-pgvector-darwin-arm64.tar.gz"
if [[ ! -f "$tarball" ]]; then
  printf 'FAIL missing %s\n' "$tarball" >&2
  exit 1
fi
assert_eq "archive name" "atomicmemory-postgres-pgvector-darwin-arm64.tar.gz" "$(basename "$tarball")"

rm -f "$src/share/extension/vector.control"
set +e
POSTGRES_SOURCE_PREFIX="$src" OUTPUT_DIR="$work/out-novec" "$PACK" >/dev/null 2>&1
novec=$?
set -e
assert_eq "missing vector.control fails" "1" "$novec"
