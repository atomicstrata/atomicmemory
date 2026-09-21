#!/usr/bin/env bash
# Bump the Rust CLI workspace semver and refresh Cargo.lock in one step.
#
# Updates [workspace.package].version, the four workspace.dependencies pins,
# and regenerates Cargo.lock so ci-rust --locked does not fail after a bump.
#
# Usage:
#   pnpm run bump:cli-version -- 0.2.2
#   bash scripts/ci/bump-cli-workspace-version.sh 0.2.2
#
# Optional env:
#   CARGO_TOML      root Cargo.toml (default: repo Cargo.toml)
#   SKIP_LOCKFILE   when set, skip cargo generate-lockfile (tests)
#   SKIP_VALIDATE   when set, skip the adjacent-bump validator (tests)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CARGO_TOML="${CARGO_TOML:-$REPO_ROOT/Cargo.toml}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
PIN_CRATES=(am-core-types am-cloud-types am-cloud-client atomicmemory)

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

rewrite_cargo_toml() {
  local ver="$1" tmp
  tmp="$(mktemp)"
  awk -v ver="$ver" '
    BEGIN {
      pins["am-core-types"] = 1
      pins["am-cloud-types"] = 1
      pins["am-cloud-client"] = 1
      pins["atomicmemory"] = 1
    }
    /^\[workspace\.package\]/ { in_pkg = 1 }
    in_pkg && /^\[/ && $0 != "[workspace.package]" { in_pkg = 0 }
    in_pkg && /^version = / {
      print "version = \"" ver "\""
      next
    }
    {
      for (crate in pins) {
        if (index($0, crate " = { path = ") == 1) {
          sub(/version = "[^"]+"/, "version = \"" ver "\"")
          print
          next
        }
      }
      print
    }
  ' "$CARGO_TOML" >"$tmp"
  mv "$tmp" "$CARGO_TOML"
}

refresh_lockfile() {
  local toml_dir
  toml_dir="$(cd "$(dirname "$CARGO_TOML")" && pwd)"
  if ! (cd "$toml_dir" && cargo generate-lockfile); then
    fail "cargo generate-lockfile failed after rewriting ${CARGO_TOML}"
  fi
}

main() {
  local ver="${1:-}"
  if [ "${1:-}" = "--" ]; then
    shift
    ver="${1:-}"
  fi
  if [ -z "$ver" ]; then
    fail "usage: bump-cli-workspace-version.sh X.Y.Z"
  fi
  if ! printf '%s' "$ver" | grep -Eq "$VERSION_RE"; then
    fail "version '${ver}' is not X.Y.Z"
  fi
  if [ ! -f "$CARGO_TOML" ]; then
    fail "Cargo.toml not found at ${CARGO_TOML}"
  fi
  rewrite_cargo_toml "$ver"
  echo "updated ${CARGO_TOML} to ${ver} (workspace + ${PIN_CRATES[*]})"
  if [ -z "${SKIP_LOCKFILE:-}" ]; then
    refresh_lockfile
    echo "refreshed Cargo.lock for workspace ${ver}"
  fi
  if [ -z "${SKIP_VALIDATE:-}" ]; then
    CARGO_TOML="$CARGO_TOML" bash "$HERE/validate-cli-version-bump.sh"
  fi
}

main "$@"
