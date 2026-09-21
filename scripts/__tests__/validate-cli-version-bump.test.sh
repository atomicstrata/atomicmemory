#!/usr/bin/env bash
#
# Contract tests for scripts/ci/validate-cli-version-bump.sh and release-cli wiring.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDATOR="$ROOT/scripts/ci/validate-cli-version-bump.sh"
BUMPER="$ROOT/scripts/ci/bump-cli-workspace-version.sh"
WORKFLOW="$ROOT/.github/workflows/release-cli.yml"
CI_RUST="$ROOT/.github/workflows/ci-rust.yml"

PASS_COUNT=0
FAIL_COUNT=0
TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

assert() {
  local name="$1"
  local condition="$2"
  if [ "$condition" = "true" ]; then
    printf '  ✓ %s\n' "$name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✗ %s\n' "$name" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

write_cargo_toml() {
  local version="$1"
  local pin_drift="${2:-}"
  local core_pin="$version"
  if [ "$pin_drift" = "drift" ]; then
    core_pin="9.9.9"
  fi
  cat >"$TMP_DIR/Cargo.toml" <<EOF
[workspace.package]
version = "${version}"

[workspace.dependencies]
am-core-types = { path = "crates/core-types", version = "${core_pin}" }
am-cloud-types = { path = "crates/cloud-types", version = "${version}" }
am-cloud-client = { path = "crates/cloud-client", version = "${version}" }
atomicmemory = { path = "crates/cli", version = "${version}" }
EOF
}

write_cargo_lock() {
  local version="$1"
  cat >"$TMP_DIR/Cargo.lock" <<EOF
[[package]]
name = "am-cloud-client"
version = "${version}"
dependencies = [
]

[[package]]
name = "am-cloud-types"
version = "${version}"
dependencies = [
]

[[package]]
name = "am-core-types"
version = "${version}"
dependencies = [
]

[[package]]
name = "atomicmemory"
version = "${version}"
dependencies = [
]
EOF
}

run_validator() {
  local expected_exit="$1"
  shift
  set +e
  env "$@" bash "$VALIDATOR" >/dev/null 2>&1
  local status=$?
  set -e
  if [ "$status" -eq "$expected_exit" ]; then
    return 0
  fi
  return 1
}

printf '\nvalidate-cli-version-bump contract tests\n'

TMP_DIR="$(mktemp -d)"

printf '\nCase: adjacent bumps from 0.2.0\n'
write_cargo_toml "0.2.1"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "patch 0.2.0 -> 0.2.1 passes" true || assert "patch 0.2.0 -> 0.2.1 passes" false

write_cargo_toml "0.3.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "minor 0.2.0 -> 0.3.0 passes" true || assert "minor 0.2.0 -> 0.3.0 passes" false

write_cargo_toml "1.0.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "major 0.2.0 -> 1.0.0 passes" true || assert "major 0.2.0 -> 1.0.0 passes" false

printf '\nCase: invalid bumps\n'
write_cargo_toml "0.2.5"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "rejects jump 0.2.0 -> 0.2.5" true || assert "rejects jump 0.2.0 -> 0.2.5" false

write_cargo_toml "0.2.0"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.1 \
  && assert "rejects downgrade 0.2.1 -> 0.2.0" true || assert "rejects downgrade 0.2.1 -> 0.2.0" false

write_cargo_toml "0.2.0"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 RELEASE_MODE=1 \
  && assert "release mode rejects unchanged 0.2.0" true || assert "release mode rejects unchanged 0.2.0" false

write_cargo_toml "0.2.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "PR mode allows unchanged 0.2.0" true || assert "PR mode allows unchanged 0.2.0" false

printf '\nCase: workspace pin lockstep\n'
write_cargo_toml "0.2.1" "drift"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "rejects pin drift" true || assert "rejects pin drift" false

printf '\nCase: Cargo.lock lockstep\n'
write_cargo_toml "0.2.1"
write_cargo_lock "0.2.1"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "aligned lockfile passes" true || assert "aligned lockfile passes" false

write_cargo_toml "0.2.1"
write_cargo_lock "0.2.0"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "rejects stale Cargo.lock" true || assert "rejects stale Cargo.lock" false

rm -f "$TMP_DIR/Cargo.lock"
write_cargo_toml "0.2.1"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/missing.lock" LAST_PUBLIC_VERSION=0.2.0 \
  && assert "rejects missing explicit Cargo.lock" true || assert "rejects missing explicit Cargo.lock" false

printf '\nCase: bump helper rewrites pins\n'
rm -f "$TMP_DIR/Cargo.lock"
write_cargo_toml "0.2.0"
SKIP_LOCKFILE=1 SKIP_VALIDATE=1 CARGO_TOML="$TMP_DIR/Cargo.toml" bash "$BUMPER" 0.2.2
grep -q 'version = "0.2.2"' "$TMP_DIR/Cargo.toml" \
  && grep -q 'am-core-types = { path = "crates/core-types", version = "0.2.2" }' "$TMP_DIR/Cargo.toml" \
  && grep -q 'atomicmemory = { path = "crates/cli", version = "0.2.2" }' "$TMP_DIR/Cargo.toml" \
  && assert "bumper updates workspace version and pins" true \
  || assert "bumper updates workspace version and pins" false

printf '\nCase: first public release\n'
rm -f "$TMP_DIR/Cargo.lock"
write_cargo_toml "0.2.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" LAST_PUBLIC_VERSION="" \
  && assert "first release allows any X.Y.Z" true || assert "first release allows any X.Y.Z" false

printf '\nCase: triggering tag present on remote (release-cli state)\n'
PUBLIC_TAG_LINES=$'abc123\trefs/tags/cli-v0.2.1\nabc124\trefs/tags/cli-v0.2.2'
write_cargo_toml "0.2.2"
write_cargo_lock "0.2.2"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS="$PUBLIC_TAG_LINES" PROPOSED_VERSION=0.2.2 RELEASE_MODE=1 \
  && assert "release mode accepts adjacent bump when triggering tag is on remote" true \
  || assert "release mode accepts adjacent bump when triggering tag is on remote" false

write_cargo_toml "0.2.1"
write_cargo_lock "0.2.1"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS="$PUBLIC_TAG_LINES" PROPOSED_VERSION=0.2.1 RELEASE_MODE=1 \
  && assert "release mode rejects re-tagging an already published version" true \
  || assert "release mode rejects re-tagging an already published version" false

write_cargo_toml "0.2.0"
write_cargo_lock "0.2.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS=$'abc123\trefs/tags/cli-v0.2.0' PROPOSED_VERSION=0.2.0 \
  && assert "PR mode allows unchanged version when only that tag exists" true \
  || assert "PR mode allows unchanged version when only that tag exists" false

write_cargo_toml "0.2.0"
write_cargo_lock "0.2.0"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS=$'abc123\trefs/tags/cli-v0.2.0' PUBLIC_CLI_RELEASES="" \
  PROPOSED_VERSION=0.2.0 RELEASE_MODE=1 \
  && assert "release mode allows first tag when no GitHub Release exists yet" true \
  || assert "release mode allows first tag when no GitHub Release exists yet" false

write_cargo_toml "0.2.2"
write_cargo_lock "0.2.2"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS="$PUBLIC_TAG_LINES" PUBLIC_CLI_RELEASES=$'0.2.1\n0.2.2' \
  PROPOSED_VERSION=0.2.2 RELEASE_MODE=1 \
  && assert "release mode rejects reusing an already-published latest version" true \
  || assert "release mode rejects reusing an already-published latest version" false

write_cargo_toml "0.2.2"
write_cargo_lock "0.2.2"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PUBLIC_CLI_TAGS="$PUBLIC_TAG_LINES" PUBLIC_CLI_RELEASES=$'0.2.1\n0.2.2' \
  PROPOSED_VERSION=0.2.2 \
  && assert "PR mode allows unchanged latest published version when an older tag exists" true \
  || assert "PR mode allows unchanged latest published version when an older tag exists" false

printf '\nCase: live gh release lookup (no PUBLIC_CLI_TAGS fixture)\n'
GH_STUB_DIR="$TMP_DIR/gh-stub"
mkdir -p "$GH_STUB_DIR"
write_gh_stub() {
  local exit_code="$1"
  local stderr_msg="$2"
  cat >"$GH_STUB_DIR/gh" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "${stderr_msg}" >&2
exit ${exit_code}
EOF
  chmod +x "$GH_STUB_DIR/gh"
}

write_cargo_toml "0.2.2"
write_cargo_lock "0.2.2"
write_gh_stub 4 "gh: authentication required"
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PATH="$GH_STUB_DIR:$PATH" LAST_PUBLIC_VERSION=0.2.1 \
  PROPOSED_VERSION=0.2.2 RELEASE_MODE=1 \
  && assert "release mode fails closed when gh release lookup is unauthenticated" true \
  || assert "release mode fails closed when gh release lookup is unauthenticated" false

write_gh_stub 1 "release not found"
run_validator 0 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PATH="$GH_STUB_DIR:$PATH" LAST_PUBLIC_VERSION=0.2.1 \
  PROPOSED_VERSION=0.2.2 RELEASE_MODE=1 \
  && assert "release mode allows adjacent bump when gh confirms release is absent" true \
  || assert "release mode allows adjacent bump when gh confirms release is absent" false

write_gh_stub 0 ""
run_validator 1 CARGO_TOML="$TMP_DIR/Cargo.toml" CARGO_LOCK="$TMP_DIR/Cargo.lock" \
  PATH="$GH_STUB_DIR:$PATH" LAST_PUBLIC_VERSION=0.2.1 \
  PROPOSED_VERSION=0.2.2 RELEASE_MODE=1 \
  && assert "release mode rejects when gh confirms the latest release already exists" true \
  || assert "release mode rejects when gh confirms the latest release already exists" false

printf '\nCase: bump helper accepts pnpm forwarded -- separator\n'
rm -f "$TMP_DIR/Cargo.lock"
write_cargo_toml "0.2.0"
SKIP_LOCKFILE=1 SKIP_VALIDATE=1 CARGO_TOML="$TMP_DIR/Cargo.toml" pnpm run bump:cli-version -- 0.2.2 >/dev/null 2>&1 \
  && grep -q 'version = "0.2.2"' "$TMP_DIR/Cargo.toml" \
  && assert "pnpm bump:cli-version -- 0.2.2 rewrites workspace version" true \
  || assert "pnpm bump:cli-version -- 0.2.2 rewrites workspace version" false

printf '\nCase: workflow wiring\n'
grep -q 'Validate public version bump' "$WORKFLOW" \
  && assert "release-cli invokes bump validator" true \
  || assert "release-cli invokes bump validator" false
grep -q 'validate-cli-version-bump.sh' "$WORKFLOW" \
  && assert "release-cli references validator script" true \
  || assert "release-cli references validator script" false
grep -q 'RELEASE_MODE=1' "$WORKFLOW" \
  && assert "release-cli sets RELEASE_MODE" true \
  || assert "release-cli sets RELEASE_MODE" false
grep -q 'GH_TOKEN:' "$WORKFLOW" \
  && assert "release-cli supplies GH_TOKEN for release lookup" true \
  || assert "release-cli supplies GH_TOKEN for release lookup" false
grep -q 'Validate CLI version bump policy' "$CI_RUST" \
  && assert "ci-rust invokes bump validator on PRs" true \
  || assert "ci-rust invokes bump validator on PRs" false
grep -q 'bump:cli-version' "$ROOT/package.json" \
  && assert "package.json exposes bump:cli-version" true \
  || assert "package.json exposes bump:cli-version" false

printf '\nResults: %s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  exit 1
fi
