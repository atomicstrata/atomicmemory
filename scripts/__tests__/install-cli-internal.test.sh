#!/usr/bin/env bash
#
# Contract tests for scripts/install-cli-internal.sh.
# Uses a fake `gh` and local fixtures; no network required.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT/scripts/install-cli-internal.sh"
FIXTURE_ROOT=""
FAKE_BIN=""
PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
  if [ -n "$FIXTURE_ROOT" ] && [ -d "$FIXTURE_ROOT" ]; then
    rm -rf "$FIXTURE_ROOT"
  fi
  if [ -n "$FAKE_BIN" ] && [ -d "$FAKE_BIN" ]; then
    rm -rf "$FAKE_BIN"
  fi
}
trap cleanup EXIT INT TERM

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

create_fake_am() {
  local path="$1"
  local ver="${2:-0.2.0}"
  cat >"$path" <<EOF
#!/bin/sh
case "\$1" in
  --version) printf 'am ${ver}\n'; exit 0 ;;
  --help) printf 'AtomicMemory CLI\n'; exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$path"
}

setup_release_fixture() {
  local ver="$1"
  local target="$2"
  local release_dir="$3"
  mkdir -p "$release_dir"
  local stage="${FIXTURE_ROOT}/stage"
  mkdir -p "$stage"
  create_fake_am "${stage}/am" "$ver"
  printf 'license\n' >"${stage}/LICENSE"
  printf 'readme\n' >"${stage}/README.md"
  tar -C "$stage" -czf "${release_dir}/am-${ver}-${target}.tar.gz" am LICENSE README.md
  (
    cd "$release_dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "am-${ver}-${target}.tar.gz" >SHA256SUMS
    else
      shasum -a 256 "am-${ver}-${target}.tar.gz" >SHA256SUMS
    fi
  )
  printf '{"version":"%s","tag":"cli-internal-latest","git_sha":"deadbeef","channel":"internal"}\n' \
    "$ver" >"${release_dir}/version.json"
  cp "$ROOT/scripts/install-cli.sh" "${release_dir}/install-cli.sh"
  cp "$ROOT/scripts/install-cli-internal.sh" "${release_dir}/install.sh"
}

install_fake_gh() {
  local release_dir="$1"
  FAKE_BIN="${FIXTURE_ROOT}/fake-bin"
  mkdir -p "$FAKE_BIN"
  cat >"${FAKE_BIN}/gh" <<EOF
#!/bin/sh
set -eu
if [ "\$1" = "release" ] && [ "\$2" = "download" ]; then
  tag="\$3"
  shift 3
  dir=""
  repo=""
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      --dir) dir="\$2"; shift 2 ;;
      --repo) repo="\$2"; shift 2 ;;
      --pattern) shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "\$dir" ] || exit 1
  [ "\$repo" = "atomicstrata/atomicmemory-internal" ] || exit 1
  case "\$tag" in
    cli-internal-latest|cli-internal-deadbeef) ;;
    *) echo "unknown tag \$tag" >&2; exit 1 ;;
  esac
  cp "${release_dir}"/* "\$dir/"
  exit 0
fi
echo "unexpected gh invocation: \$*" >&2
exit 1
EOF
  chmod +x "${FAKE_BIN}/gh"
  export PATH="${FAKE_BIN}:$PATH"
}

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os_part="unknown-linux-gnu" ;;
    Darwin) os_part="apple-darwin" ;;
    *) printf 'unsupported\n'; return 1 ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch_part="x86_64" ;;
    arm64 | aarch64) arch_part="aarch64" ;;
    *) printf 'unsupported\n'; return 1 ;;
  esac
  printf '%s-%s' "$arch_part" "$os_part"
}

main() {
  printf 'install-cli-internal tests\n'
  FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/am-internal-test.XXXXXX")"
  local test_home="${FIXTURE_ROOT}/home"
  mkdir -p "$test_home"
  HOME="$test_home"
  PATH="/usr/bin:/bin:/usr/sbin:/sbin"
  SHELL="/bin/sh"
  XDG_CONFIG_HOME="${test_home}/.config"
  ZDOTDIR="$test_home"
  export HOME PATH SHELL XDG_CONFIG_HOME ZDOTDIR
  unset AM_INSTALL_DIR AM_VERSION AM_NO_MODIFY_PATH AM_ENVIRONMENT AM_CORE_IMAGE
  unset AM_VERIFY_ATTESTATION AM_FORCE
  local ver="0.2.0"
  local target
  target="$(detect_target)" || {
    printf 'skip: unsupported platform\n'
    exit 0
  }
  local release_dir="${FIXTURE_ROOT}/release"
  setup_release_fixture "$ver" "$target" "$release_dir"
  install_fake_gh "$release_dir"

  local bin_dir="${FIXTURE_ROOT}/bin"
  mkdir -p "$bin_dir"
  if ! AM_INTERNAL_REPO=atomicstrata/atomicmemory-internal \
    AM_INTERNAL_TAG=cli-internal-latest \
    sh "$INSTALLER" --bin-dir "$bin_dir" --no-modify-path; then
    assert "install from floating internal tag" false
  else
    assert "install from floating internal tag" true
  fi
  if [ -x "${bin_dir}/am" ] && [ "$("${bin_dir}/am" --version)" = "am ${ver}" ]; then
    assert "installed binary reports expected version" true
  else
    assert "installed binary reports expected version" false
  fi

  if AM_INTERNAL_TAG=cli-v0.2.0 sh "$INSTALLER" --bin-dir "$bin_dir" --no-modify-path 2>/dev/null; then
    assert "refuses public cli-v tag" false
  else
    assert "refuses public cli-v tag" true
  fi

  # Hostile sibling beside the downloaded wrapper must never win over the
  # authenticated release asset (trust boundary for private GitHub Releases).
  local wrap_dir="${FIXTURE_ROOT}/wrap"
  local hostile_marker="${FIXTURE_ROOT}/hostile-ran"
  mkdir -p "$wrap_dir"
  cp "$INSTALLER" "${wrap_dir}/install.sh"
  cat >"${wrap_dir}/install-cli.sh" <<'HOSTILE'
#!/bin/sh
printf 'hostile\n' >"${AM_HOSTILE_MARKER:?}"
exit 42
HOSTILE
  chmod +x "${wrap_dir}/install-cli.sh"
  rm -f "$hostile_marker"
  local wrap_bin="${FIXTURE_ROOT}/bin-wrap"
  mkdir -p "$wrap_bin"
  if ! AM_INTERNAL_REPO=atomicstrata/atomicmemory-internal \
    AM_INTERNAL_TAG=cli-internal-latest \
    AM_HOSTILE_MARKER="$hostile_marker" \
    sh "${wrap_dir}/install.sh" --bin-dir "$wrap_bin" --no-modify-path; then
    assert "install ignores hostile sibling install-cli.sh" false
  else
    assert "install ignores hostile sibling install-cli.sh" true
  fi
  if [ -f "$hostile_marker" ]; then
    assert "hostile sibling install-cli.sh was not executed" false
  else
    assert "hostile sibling install-cli.sh was not executed" true
  fi
  if [ -x "${wrap_bin}/am" ] && [ "$("${wrap_bin}/am" --version)" = "am ${ver}" ]; then
    assert "install still uses release install-cli.sh asset" true
  else
    assert "install still uses release install-cli.sh asset" false
  fi

  printf '\n%d passed, %d failed\n' "$PASS_COUNT" "$FAIL_COUNT"
  [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
