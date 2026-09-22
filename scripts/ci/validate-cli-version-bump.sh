#!/usr/bin/env bash
# Validate public `am` CLI semver bumps against the last published cli-v* tag.
#
# Single chokepoint for release-cli.yml (hard gate) and ci-rust.yml (PR gate).
# Adjacent bumps only: patch +1, minor +1 with patch 0, or major +1 with
# minor/patch 0. Workspace dependency pins must match [workspace.package].version.
#
# Optional env:
#   CARGO_TOML            path to root Cargo.toml (default: Cargo.toml)
#   CARGO_LOCK            path to Cargo.lock (default: sibling of CARGO_TOML)
#   PROPOSED_VERSION      version under test (default: workspace.package.version)
#   LAST_PUBLIC_VERSION   override last public semver (tests / offline)
#   PUBLIC_CLI_TAGS       ls-remote-shaped tag lines for tests (skips git ls-remote)
#   PUBLIC_CLI_RELEASES   published GitHub Release versions for tests (skips gh)
#   PUBLIC_REPO           git remote for cli-v* tags (default: public product repo)
#   RELEASE_MODE          when set, fail if proposed equals last public (tag push)
set -euo pipefail

CARGO_TOML="${CARGO_TOML:-Cargo.toml}"
PUBLIC_REPO="${PUBLIC_REPO:-https://github.com/atomicstrata/atomicmemory.git}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
PIN_CRATES=(am-core-types am-cloud-types am-cloud-client atomicmemory)

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

read_workspace_version() {
  local ver
  ver="$(awk '/^\[workspace\.package\]/{found=1; next} found && /^version = /{
    gsub(/[" ]/,"",$3); print $3; exit
  }' "$CARGO_TOML")"
  if [ -z "$ver" ]; then
    fail "could not read [workspace.package].version from ${CARGO_TOML}"
  fi
  if ! printf '%s' "$ver" | grep -Eq "$VERSION_RE"; then
    fail "workspace version '${ver}' is not X.Y.Z"
  fi
  printf '%s' "$ver"
}

read_pin_version() {
  local crate="$1"
  sed -n "s/^${crate} = { path = .* version = \"\\([^\"]*\\)\".*/\\1/p" "$CARGO_TOML"
}

assert_workspace_pins() {
  local workspace_ver="$1"
  local crate pin
  for crate in "${PIN_CRATES[@]}"; do
    pin="$(read_pin_version "$crate")"
    if [ -z "$pin" ]; then
      fail "could not read workspace.dependencies pin for ${crate} in ${CARGO_TOML}"
    fi
    if [ "$pin" != "$workspace_ver" ]; then
      fail "workspace pin ${crate}=${pin} does not match [workspace.package].version=${workspace_ver}"
    fi
  done
}

resolve_cargo_lock() {
  if [ -n "${CARGO_LOCK:-}" ]; then
    printf '%s' "$CARGO_LOCK"
    return
  fi
  local sibling
  sibling="$(dirname "$CARGO_TOML")/Cargo.lock"
  if [ -f "$sibling" ]; then
    printf '%s' "$sibling"
  fi
}

read_lock_version() {
  local crate="$1" lock="$2"
  awk -v crate="$crate" '
    function flush() {
      if (done) return
      if (pending != "" && has_source == 0) {
        print pending
        done = 1
        exit
      }
      pending = ""
      has_source = 0
    }
    /^\[\[package\]\]/ { flush() }
    /^name = / { gsub(/"/, "", $3); name = $3 }
    /^version = / {
      gsub(/"/, "", $3)
      if (name == crate) pending = $3
    }
    /^source = / { has_source = 1 }
    END { flush() }
  ' "$lock"
}

assert_lockfile_versions() {
  local workspace_ver="$1"
  local lock crate lock_ver
  lock="$(resolve_cargo_lock || true)"
  if [ -z "$lock" ]; then
    return 0
  fi
  if [ ! -f "$lock" ]; then
    fail "Cargo.lock not found at ${lock}; run: pnpm run bump:cli-version -- ${workspace_ver}"
  fi
  for crate in "${PIN_CRATES[@]}"; do
    lock_ver="$(read_lock_version "$crate" "$lock")"
    if [ -z "$lock_ver" ]; then
      fail "could not read ${crate} version from ${lock}"
    fi
    if [ "$lock_ver" != "$workspace_ver" ]; then
      fail "${crate} in ${lock} is ${lock_ver}, expected ${workspace_ver}; run: pnpm run bump:cli-version -- ${workspace_ver}"
    fi
  done
}

semver_gt() {
  local left="$1" right="$2"
  local l_major l_minor l_patch r_major r_minor r_patch
  IFS=. read -r l_major l_minor l_patch <<<"$left"
  IFS=. read -r r_major r_minor r_patch <<<"$right"
  if ((10#$l_major > 10#$r_major)); then return 0; fi
  if ((10#$l_major < 10#$r_major)); then return 1; fi
  if ((10#$l_minor > 10#$r_minor)); then return 0; fi
  if ((10#$l_minor < 10#$r_minor)); then return 1; fi
  ((10#$l_patch > 10#$r_patch))
}

allowed_next_versions() {
  local base="$1"
  local major minor patch
  IFS=. read -r major minor patch <<<"$base"
  printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))"
  printf '%s.%s.0\n' "$major" "$((minor + 1))"
  printf '%s.0.0\n' "$((major + 1))"
}

is_adjacent_bump() {
  local from="$1" to="$2" candidate
  while IFS= read -r candidate; do
    if [ "$candidate" = "$to" ]; then
      return 0
    fi
  done < <(allowed_next_versions "$from")
  return 1
}

fetch_public_cli_tag_lines() {
  if [ "${PUBLIC_CLI_TAGS+set}" = "set" ]; then
    printf '%s' "$PUBLIC_CLI_TAGS"
    return 0
  fi
  git ls-remote --tags "$PUBLIC_REPO" 'refs/tags/cli-v*' 2>/dev/null
}

parse_tag_line_version() {
  local tag="$1"
  local ver="${tag##*/cli-v}"
  ver="${ver%%\^*}"
  if printf '%s' "$ver" | grep -Eq "$VERSION_RE"; then
    printf '%s' "$ver"
  fi
}

public_release_repo() {
  local repo="${PUBLIC_REPO#https://github.com/}"
  repo="${repo%.git}"
  printf '%s' "$repo"
}

# A git tag is not a publication. release-cli creates the GitHub Release after
# this gate, so the triggering tag always exists while the release may not.
# gh exit 0 = published; a confirmed 404 = absent; any other failure is closed.
published_release_exists() {
  local proposed="$1" line ver
  if [ "${PUBLIC_CLI_TAGS+set}" = "set" ] || [ "${PUBLIC_CLI_RELEASES+set}" = "set" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      ver="${line#cli-v}"
      if [ "$ver" = "$proposed" ]; then
        return 0
      fi
    done <<<"${PUBLIC_CLI_RELEASES:-}"
    return 1
  fi
  if [ -z "${RELEASE_MODE:-}" ]; then
    return 1
  fi
  lookup_published_release "$proposed"
}

lookup_published_release() {
  local proposed="$1" repo status
  repo="$(public_release_repo)"
  if ! command -v gh >/dev/null 2>&1; then
    fail "cannot determine whether cli-v${proposed} is already published (gh not available)"
  fi
  local err
  err="$(mktemp)"
  set +e
  gh release view "cli-v${proposed}" --repo "$repo" >/dev/null 2>"$err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    rm -f "$err"
    return 0
  fi
  if [ "$status" -eq 1 ] && grep -qiE 'not found|HTTP[[:space:]]*404' "$err"; then
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  fail "cannot determine whether cli-v${proposed} is already published (gh exited ${status})"
}

# Previous published baseline: max cli-v* semver excluding the release under test.
# The triggering tag is already on the remote when release-cli runs, so counting
# it as "last public" rejects valid adjacent releases (0.2.1 -> 0.2.2).
resolve_last_public_version() {
  local exclude_ver="${1:-}"

  if [ "${LAST_PUBLIC_VERSION+set}" = "set" ]; then
    printf '%s' "$LAST_PUBLIC_VERSION"
    return
  fi

  local tags tag ver best=""
  if ! tags="$(fetch_public_cli_tag_lines)"; then
    fail "could not list public cli-v* tags from ${PUBLIC_REPO}"
  fi
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    ver="$(parse_tag_line_version "$tag")"
    [ -n "$ver" ] || continue
    if [ -n "$exclude_ver" ] && [ "$ver" = "$exclude_ver" ]; then
      continue
    fi
    if [ -z "$best" ] || semver_gt "$ver" "$best"; then
      best="$ver"
    fi
  done <<<"$tags"
  if [ -n "$best" ]; then
    printf '%s' "$best"
  fi
}

validate_bump() {
  local proposed="$1" last="$2"
  if [ -z "$last" ]; then
    if published_release_exists "$proposed"; then
      if [ -n "${RELEASE_MODE:-}" ]; then
        fail "refusing release ${proposed}: cli-v${proposed} is already published"
      fi
      echo "ok: workspace version ${proposed} matches last public release (no bump yet)"
      return 0
    fi
    echo "ok: first public release (${proposed}); no prior cli-v* baseline"
    return 0
  fi
  if [ "$proposed" = "$last" ]; then
    if [ -n "${RELEASE_MODE:-}" ]; then
      fail "refusing release ${proposed}: identical to last public cli-v${last}"
    fi
    echo "ok: workspace version ${proposed} matches last public release (no bump yet)"
    return 0
  fi
  if ! semver_gt "$proposed" "$last"; then
    fail "refusing ${proposed}: lower than last public cli-v${last}"
  fi
  if ! is_adjacent_bump "$last" "$proposed"; then
    local allowed
    allowed="$(allowed_next_versions "$last" | tr '\n' ',' | sed 's/,$//')"
    fail "refusing ${proposed}: not an adjacent bump from last public ${last} (allowed: ${allowed})"
  fi
  if published_release_exists "$proposed"; then
    if [ -n "${RELEASE_MODE:-}" ]; then
      fail "refusing release ${proposed}: cli-v${proposed} is already published"
    fi
    echo "ok: workspace version ${proposed} matches last public release (no bump yet)"
    return 0
  fi
  echo "ok: ${proposed} is a valid adjacent bump from last public ${last}"
}

main() {
  local workspace_ver proposed last
  workspace_ver="$(read_workspace_version)"
  proposed="${PROPOSED_VERSION:-$workspace_ver}"
  if ! printf '%s' "$proposed" | grep -Eq "$VERSION_RE"; then
    fail "proposed version '${proposed}' is not X.Y.Z"
  fi
  if [ "$proposed" != "$workspace_ver" ] && [ -n "${RELEASE_MODE:-}" ]; then
    fail "proposed version ${proposed} does not match workspace version ${workspace_ver}"
  fi
  assert_workspace_pins "$workspace_ver"
  assert_lockfile_versions "$workspace_ver"
  last="$(resolve_last_public_version "$proposed" || true)"
  validate_bump "$proposed" "$last"
}

main "$@"
