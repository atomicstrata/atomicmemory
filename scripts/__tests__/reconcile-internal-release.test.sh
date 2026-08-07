#!/usr/bin/env bash
# Contract tests for scripts/ci/reconcile-internal-release.sh.
#
# Exercised with a fake `gh` and local fixtures. Each case models a
# concrete rerun of the Internal CLI Release workflow. The property
# under test is content trust: on any release_exists=true path, dist/
# must end up carrying the immutable release's actual bytes (never a
# freshly rebuilt divergent copy that shares only asset names).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RECONCILE="$ROOT/scripts/ci/reconcile-internal-release.sh"

PASS_COUNT=0
FAIL_COUNT=0
FIXTURE_ROOT=""
FAKE_BIN=""

cleanup() {
  [ -n "$FIXTURE_ROOT" ] && [ -d "$FIXTURE_ROOT" ] && rm -rf "$FIXTURE_ROOT"
  [ -n "$FAKE_BIN" ] && [ -d "$FAKE_BIN" ] && rm -rf "$FAKE_BIN"
}
trap cleanup EXIT INT TERM

assert() {
  local name="$1" condition="$2"
  if [ "$condition" = "true" ]; then
    printf '  ✓ %s\n' "$name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    printf '  ✗ %s\n' "$name" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256sums_for_dir() {
  local dir="$1"
  (
    cd "$dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum am-*.tar.gz
    else
      shasum -a 256 am-*.tar.gz
    fi
  )
}

# Build a fake remote release directory with a tarball named after
# $target, plus SHA256SUMS/install-cli.sh/install.sh/version.json.
seed_release() {
  local dir="$1" ver="$2" target="$3" payload="${4:-remote-payload}"
  mkdir -p "$dir"
  local stage
  stage="$(mktemp -d)"
  printf '%s\n' "$payload" >"$stage/am"
  printf 'license\n' >"$stage/LICENSE"
  printf 'readme\n' >"$stage/README.md"
  tar -C "$stage" -czf "${dir}/am-${ver}-${target}.tar.gz" am LICENSE README.md
  rm -rf "$stage"
  sha256sums_for_dir "$dir" >"${dir}/SHA256SUMS"
  printf 'install-cli\n' >"${dir}/install-cli.sh"
  printf 'install\n' >"${dir}/install.sh"
  printf '{"version":"%s","tag":"cli-internal-abc","git_sha":"abc","channel":"internal"}\n' \
    "$ver" >"${dir}/version.json"
}

# Build the local dist/ with the SAME asset names as the release but
# DIFFERENT tarball bytes, modeling a non-reproducible rerun.
seed_local_dist_same_names() {
  local dir="$1" ver="$2" target="$3" payload="${4:-local-rebuild}"
  mkdir -p "$dir"
  local stage
  stage="$(mktemp -d)"
  printf '%s\n' "$payload" >"$stage/am"
  printf 'license\n' >"$stage/LICENSE"
  printf 'readme\n' >"$stage/README.md"
  tar -C "$stage" -czf "${dir}/am-${ver}-${target}.tar.gz" am LICENSE README.md
  rm -rf "$stage"
  sha256sums_for_dir "$dir" >"${dir}/SHA256SUMS"
  printf 'install-cli\n' >"${dir}/install-cli.sh"
  printf 'install\n' >"${dir}/install.sh"
  printf '{"version":"%s","tag":"cli-internal-abc","git_sha":"abc","channel":"internal"}\n' \
    "$ver" >"${dir}/version.json"
}

# Fake `gh` backed by a per-test scenario file:
#   scenario.env holds RELEASE_JSON path, DOWNLOAD_DIR path,
#   DOWNLOAD_MODE (ok|fail|torn).
install_fake_gh() {
  FAKE_BIN="${FIXTURE_ROOT}/fake-bin"
  mkdir -p "$FAKE_BIN"
  cat >"${FAKE_BIN}/gh" <<'EOF'
#!/usr/bin/env bash
set -eu
scenario="${AM_TEST_SCENARIO:?}"
# shellcheck disable=SC1090
. "$scenario"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ -n "${RELEASE_JSON:-}" ] && [ -f "$RELEASE_JSON" ]; then
    cat "$RELEASE_JSON"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  # Parse --dir out of remaining args.
  shift 3
  dir=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) dir="$2"; shift 2 ;;
      --repo|--pattern) shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$dir" ] || exit 1
  case "${DOWNLOAD_MODE:-ok}" in
    ok)
      cp "${DOWNLOAD_DIR}"/* "$dir/"
      ;;
    torn)
      cp "${DOWNLOAD_DIR}"/SHA256SUMS "$dir/"
      cp "${DOWNLOAD_DIR}"/install-cli.sh "$dir/"
      cp "${DOWNLOAD_DIR}"/install.sh "$dir/"
      cp "${DOWNLOAD_DIR}"/version.json "$dir/"
      ;;
    fail)
      exit 2
      ;;
  esac
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
EOF
  chmod +x "${FAKE_BIN}/gh"
  export PATH="${FAKE_BIN}:$PATH"
}

write_release_json() {
  local out="$1" target_sha="$2" names_dir="$3"
  local assets
  assets="$(ls "$names_dir" | LC_ALL=C sort | jq -R -s -c 'split("\n") | map(select(length > 0)) | map({name: .})')"
  printf '{"targetCommitish":"%s","assets":%s}\n' "$target_sha" "$assets" >"$out"
}

write_scenario() {
  local out="$1" release_json="$2" download_dir="$3" mode="${4:-ok}"
  {
    printf 'RELEASE_JSON=%q\n' "$release_json"
    printf 'DOWNLOAD_DIR=%q\n' "$download_dir"
    printf 'DOWNLOAD_MODE=%q\n' "$mode"
  } >"$out"
}

run_reconcile() {
  local scenario="$1" tag="$2" sha="$3" dist_dir="$4"
  local out_file="${FIXTURE_ROOT}/github_output"
  local stdout_file="${FIXTURE_ROOT}/last.stdout"
  local stderr_file="${FIXTURE_ROOT}/last.stderr"
  : >"$out_file"
  : >"$stdout_file"
  : >"$stderr_file"
  local rc=0
  AM_TEST_SCENARIO="$scenario" \
  GH_REPO="atomicstrata/atomicmemory-internal" \
  TAG="$tag" \
  SHA="$sha" \
  DIST_DIR="$dist_dir" \
  GITHUB_OUTPUT="$out_file" \
    bash "$RECONCILE" >"$stdout_file" 2>"$stderr_file" || rc=$?
  printf '%s' "$rc"
}

output_value() {
  local key="$1"
  awk -F= -v k="$key" '$1==k {print $2; exit}' "${FIXTURE_ROOT}/github_output" 2>/dev/null || true
}

main() {
  printf 'reconcile-internal-release tests\n'
  FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/am-reconcile-test.XXXXXX")"
  install_fake_gh

  local ver="0.2.0" target="x86_64-unknown-linux-gnu" sha="abc123"

  # Case 1: no existing release -> release_exists=false, dist/ untouched.
  local case1="${FIXTURE_ROOT}/case1"
  local dist1="${case1}/dist" scenario1="${case1}/scenario"
  mkdir -p "$case1"
  seed_local_dist_same_names "$dist1" "$ver" "$target" "local-rebuild"
  local local_am_before1
  local_am_before1="$(sha256_of "${dist1}/am-${ver}-${target}.tar.gz")"
  : >"${case1}/no-release.json"
  # Point RELEASE_JSON to a non-existent file so gh release view returns 1.
  write_scenario "$scenario1" "${case1}/missing.json" "${case1}/no-download" ok
  local rc1
  rc1="$(run_reconcile "$scenario1" "cli-internal-${sha}" "$sha" "$dist1")"
  local exists1
  exists1="$(output_value release_exists)"
  local local_am_after1=""
  [ -f "${dist1}/am-${ver}-${target}.tar.gz" ] && \
    local_am_after1="$(sha256_of "${dist1}/am-${ver}-${target}.tar.gz")"
  if [ "$rc1" = "0" ] && [ "$exists1" = "false" ] && [ "$local_am_before1" = "$local_am_after1" ]; then
    assert "no existing release: release_exists=false and dist/ untouched" true
  else
    assert "no existing release: release_exists=false and dist/ untouched (rc=$rc1 exists=$exists1)" false
  fi

  # Case 2: existing release, same target SHA and same asset names,
  # but tarball bytes DIFFER between local rebuild and remote. dist/
  # must end up carrying the REMOTE bytes, and release_exists=true.
  local case2="${FIXTURE_ROOT}/case2"
  local dist2="${case2}/dist" remote2="${case2}/remote"
  local scenario2="${case2}/scenario" release2="${case2}/release.json"
  mkdir -p "$case2"
  seed_local_dist_same_names "$dist2" "$ver" "$target" "local-rebuild"
  seed_release "$remote2" "$ver" "$target" "remote-payload"
  local remote_hash2 local_hash2
  remote_hash2="$(sha256_of "${remote2}/am-${ver}-${target}.tar.gz")"
  local_hash2="$(sha256_of "${dist2}/am-${ver}-${target}.tar.gz")"
  if [ "$remote_hash2" = "$local_hash2" ]; then
    assert "case2 setup: remote and local tarballs must differ" false
  fi
  write_release_json "$release2" "$sha" "$remote2"
  write_scenario "$scenario2" "$release2" "$remote2" ok
  local rc2
  rc2="$(run_reconcile "$scenario2" "cli-internal-${sha}" "$sha" "$dist2")"
  local exists2 after_hash2
  exists2="$(output_value release_exists)"
  after_hash2="$(sha256_of "${dist2}/am-${ver}-${target}.tar.gz")"
  if [ "$rc2" = "0" ] && [ "$exists2" = "true" ] && [ "$after_hash2" = "$remote_hash2" ] && [ "$after_hash2" != "$local_hash2" ]; then
    assert "existing release: dist/ swapped to immutable release bytes" true
  else
    assert "existing release: dist/ swapped to immutable release bytes (rc=$rc2 exists=$exists2)" false
  fi

  # Case 3: existing release, target SHA mismatch -> fail closed.
  local case3="${FIXTURE_ROOT}/case3"
  local dist3="${case3}/dist" remote3="${case3}/remote"
  local scenario3="${case3}/scenario" release3="${case3}/release.json"
  mkdir -p "$case3"
  seed_local_dist_same_names "$dist3" "$ver" "$target" "local-rebuild"
  seed_release "$remote3" "$ver" "$target" "remote-payload"
  write_release_json "$release3" "def456" "$remote3"
  write_scenario "$scenario3" "$release3" "$remote3" ok
  local rc3
  rc3="$(run_reconcile "$scenario3" "cli-internal-${sha}" "$sha" "$dist3")"
  if [ "$rc3" != "0" ] && grep -q "Immutable releases cannot be repointed" "${FIXTURE_ROOT}/last.stderr"; then
    assert "target SHA mismatch fails closed" true
  else
    assert "target SHA mismatch fails closed (rc=$rc3)" false
  fi

  # Case 4: existing release, asset name manifest differs -> fail closed.
  local case4="${FIXTURE_ROOT}/case4"
  local dist4="${case4}/dist" remote4="${case4}/remote"
  local scenario4="${case4}/scenario" release4="${case4}/release.json"
  mkdir -p "$case4"
  seed_local_dist_same_names "$dist4" "$ver" "$target" "local-rebuild"
  seed_release "$remote4" "$ver" "$target" "remote-payload"
  printf 'extra\n' >"${remote4}/extra-asset.txt"
  write_release_json "$release4" "$sha" "$remote4"
  rm -f "${remote4}/extra-asset.txt"
  write_scenario "$scenario4" "$release4" "$remote4" ok
  local rc4
  rc4="$(run_reconcile "$scenario4" "cli-internal-${sha}" "$sha" "$dist4")"
  if [ "$rc4" != "0" ] && grep -q "asset manifest differs" "${FIXTURE_ROOT}/last.stderr"; then
    assert "asset name manifest mismatch fails closed" true
  else
    assert "asset name manifest mismatch fails closed (rc=$rc4)" false
  fi

  # Case 5: downloaded SHA256SUMS does not match downloaded tarballs
  # (e.g. a corrupted remote asset) -> fail closed, dist/ NOT swapped
  # to unverified bytes.
  local case5="${FIXTURE_ROOT}/case5"
  local dist5="${case5}/dist" remote5="${case5}/remote"
  local scenario5="${case5}/scenario" release5="${case5}/release.json"
  mkdir -p "$case5"
  seed_local_dist_same_names "$dist5" "$ver" "$target" "local-rebuild"
  seed_release "$remote5" "$ver" "$target" "remote-payload"
  local local_hash5
  local_hash5="$(sha256_of "${dist5}/am-${ver}-${target}.tar.gz")"
  # Corrupt the remote SHA256SUMS so self-consistency fails. Use a
  # well-formed 64-hex-char digest that just does not match the actual
  # tarball; short-hex "deadbeef" would be silently skipped by
  # `sha256sum -c` as improperly formatted (see also the script's
  # explicit strict-check hook).
  printf '0000000000000000000000000000000000000000000000000000000000000000  am-%s-%s.tar.gz\n' \
    "$ver" "$target" >"${remote5}/SHA256SUMS"
  write_release_json "$release5" "$sha" "$remote5"
  write_scenario "$scenario5" "$release5" "$remote5" ok
  local rc5
  rc5="$(run_reconcile "$scenario5" "cli-internal-${sha}" "$sha" "$dist5")"
  local after_hash5
  after_hash5="$(sha256_of "${dist5}/am-${ver}-${target}.tar.gz")"
  if [ "$rc5" != "0" ] && grep -q "SHA256SUMS" "${FIXTURE_ROOT}/last.stderr" && [ "$after_hash5" = "$local_hash5" ]; then
    assert "SHA256SUMS mismatch fails closed and preserves local dist" true
  else
    assert "SHA256SUMS mismatch fails closed and preserves local dist (rc=$rc5)" false
  fi

  # Case 6a: SHA256SUMS carries a short-hex digest ("deadbeef") that
  # sha256sum -c would silently skip as improperly formatted. The
  # pre-validation in the script must catch this and fail closed so a
  # hand-forged SHA256SUMS cannot pair a name with unchecked bytes.
  local case6a="${FIXTURE_ROOT}/case6a"
  local dist6a="${case6a}/dist" remote6a="${case6a}/remote"
  local scenario6a="${case6a}/scenario" release6a="${case6a}/release.json"
  mkdir -p "$case6a"
  seed_local_dist_same_names "$dist6a" "$ver" "$target" "local-rebuild"
  seed_release "$remote6a" "$ver" "$target" "remote-payload"
  printf 'deadbeef  am-%s-%s.tar.gz\n' "$ver" "$target" >"${remote6a}/SHA256SUMS"
  local local_hash6a
  local_hash6a="$(sha256_of "${dist6a}/am-${ver}-${target}.tar.gz")"
  write_release_json "$release6a" "$sha" "$remote6a"
  write_scenario "$scenario6a" "$release6a" "$remote6a" ok
  local rc6a
  rc6a="$(run_reconcile "$scenario6a" "cli-internal-${sha}" "$sha" "$dist6a")"
  local after_hash6a
  after_hash6a="$(sha256_of "${dist6a}/am-${ver}-${target}.tar.gz")"
  if [ "$rc6a" != "0" ] && grep -q "malformed" "${FIXTURE_ROOT}/last.stderr" && [ "$after_hash6a" = "$local_hash6a" ]; then
    assert "malformed SHA256SUMS (short-hex) fails closed" true
  else
    assert "malformed SHA256SUMS (short-hex) fails closed (rc=$rc6a)" false
  fi

  # Case 6: downloaded set missing an expected asset (torn download).
  local case6="${FIXTURE_ROOT}/case6"
  local dist6="${case6}/dist" remote6="${case6}/remote"
  local scenario6="${case6}/scenario" release6="${case6}/release.json"
  mkdir -p "$case6"
  seed_local_dist_same_names "$dist6" "$ver" "$target" "local-rebuild"
  seed_release "$remote6" "$ver" "$target" "remote-payload"
  write_release_json "$release6" "$sha" "$remote6"
  # Torn download: skips the tarball.
  write_scenario "$scenario6" "$release6" "$remote6" torn
  local rc6
  rc6="$(run_reconcile "$scenario6" "cli-internal-${sha}" "$sha" "$dist6")"
  if [ "$rc6" != "0" ]; then
    assert "torn download (missing tarball) fails closed" true
  else
    assert "torn download (missing tarball) fails closed (rc=$rc6)" false
  fi

  printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
