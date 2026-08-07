#!/usr/bin/env bash
#
# Focused installer contract tests for scripts/install-cli.sh.
# Uses a local fixture HTTP server; no network or R2 access required.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT/scripts/install-cli.sh"
FIXTURE_ROOT=""
SERVER_PID=""
PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$FIXTURE_ROOT" ] && [ -d "$FIXTURE_ROOT" ]; then
    rm -rf "$FIXTURE_ROOT"
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
  --quiet) shift; exec "\$0" "\$@" ;;
  config)
    case "\$2" in
      env)
        [ "\$4" = "invalid" ] && exit 1
        exit 0
        ;;
      set)
        [ "\$4" = "bad-image" ] && exit 1
        exit 0
        ;;
    esac
    exit 0
    ;;
  init) exit 0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$path"
}

write_checksums() {
  local dir="$1"
  local ver="$2"
  local target="$3"
  (
    cd "$dir"
    sha256sum "am-${ver}-${target}.tar.gz" >SHA256SUMS
  )
}

publish_fixture_tarball() {
  local ver="$1"
  local target="$2"
  local rel="${FIXTURE_ROOT}/cli/v${ver}"
  local stage="${FIXTURE_ROOT}/stage-${ver}"
  mkdir -p "$rel" "$stage"
  create_fake_am "$stage/am" "$ver"
  cp "$ROOT/LICENSE" "$stage/LICENSE"
  cp "$ROOT/crates/cli/README.md" "$stage/README.md"
  tar -C "$stage" -czf "${rel}/am-${ver}-${target}.tar.gz" am LICENSE README.md
  write_checksums "$rel" "$ver" "$target"
}

wait_for_server() {
  local base="$1"
  local attempt=0
  while [ "$attempt" -lt 30 ]; do
    if curl -fsS "${base}/version.json" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
  return 1
}

start_fixture_server() {
  local ver="$1"
  local target="$2"
  FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/install-cli-fixture.XXXXXX")"
  publish_fixture_tarball "$ver" "$target"
  printf '{"version":"%s","tag":"cli-v%s"}\n' "$ver" "$ver" >"${FIXTURE_ROOT}/version.json"
  local port
  port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  (
    cd "$FIXTURE_ROOT"
    python3 -m http.server "$port" >/dev/null 2>&1 &
    echo $! >server.pid
  )
  SERVER_PID="$(cat "${FIXTURE_ROOT}/server.pid")"
  AM_BASE_URL="http://127.0.0.1:${port}"
  wait_for_server "$AM_BASE_URL" || {
    printf 'fixture server failed to start at %s\n' "$AM_BASE_URL" >&2
    exit 1
  }
}

detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os_part="unknown-linux-gnu" ;;
    Darwin) os_part="apple-darwin" ;;
    *) echo "unsupported"; return 1 ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch_part="x86_64" ;;
    arm64 | aarch64) arch_part="aarch64" ;;
    *) echo "unsupported"; return 1 ;;
  esac
  printf '%s-%s' "$arch_part" "$os_part"
}

run_install() {
  AM_BASE_URL="$AM_BASE_URL" sh "$INSTALLER" "$@" 2>&1
}

printf '\ninstall-cli contract tests\n'

TARGET="$(detect_target)"
start_fixture_server "0.2.0" "$TARGET"
BIN_DIR="${FIXTURE_ROOT}/bin"
mkdir -p "$BIN_DIR"

printf '\nCase: installer defers execution until main invocation\n'
grep -q '^main() {' "$INSTALLER" && assert "installer declares main wrapper" true \
  || assert "installer declares main wrapper" false
last_line="$(tail -n 1 "$INSTALLER")"
[ "$last_line" = 'main "$@"' ] && assert "installer invokes main at EOF" true \
  || assert "installer invokes main at EOF" false

printf '\nCase: successful install verifies identity and version\n'
if run_install --version 0.2.0 --bin-dir "$BIN_DIR" --no-modify-path >/dev/null; then
  got="$("$BIN_DIR/am" --version)"
  if [ "$got" = "am 0.2.0" ]; then
    assert "install succeeds and binary reports am 0.2.0" true
  else
    assert "install succeeds and binary reports am 0.2.0" false
  fi
else
  assert "install succeeds and binary reports am 0.2.0" false
fi

printf '\nCase: invalid version is rejected\n'
output="$(run_install --version '0.2.0; echo pwned' --bin-dir "$BIN_DIR/reject" --no-modify-path 2>&1 || true)"
case "$output" in
  *'invalid version'*) assert "invalid version fails closed with message" true ;;
  *) assert "invalid version fails closed with message" false ;;
esac
[ ! -x "$BIN_DIR/reject/am" ] && assert "invalid version does not install binary" true \
  || assert "invalid version does not install binary" false

printf '\nCase: regex-like version mismatch is rejected\n'
bad_stage="${FIXTURE_ROOT}/bad-stage"
mkdir -p "$bad_stage"
create_fake_am "$bad_stage/am" "0x2x0"
cp "$ROOT/LICENSE" "$bad_stage/LICENSE"
cp "$ROOT/crates/cli/README.md" "$bad_stage/README.md"
good_rel="${FIXTURE_ROOT}/cli/v0.2.0"
tar -C "$bad_stage" -czf "${good_rel}/am-0.2.0-${TARGET}.tar.gz" am LICENSE README.md
write_checksums "$good_rel" "0.2.0" "$TARGET"
output="$(AM_BASE_URL="$AM_BASE_URL" AM_VERSION=0.2.0 sh "$INSTALLER" \
  --bin-dir "$BIN_DIR/bad-ver" --no-modify-path 2>&1 || true)"
case "$output" in
  *'version mismatch'*) assert "lookalike version fails string equality" true ;;
  *) assert "lookalike version fails string equality" false ;;
esac
[ ! -x "$BIN_DIR/bad-ver/am" ] && assert "lookalike version does not install binary" true \
  || assert "lookalike version does not install binary" false
publish_fixture_tarball "0.2.0" "$TARGET"

printf '\nCase: failed upgrade preserves existing am\n'
upgrade_dir="$BIN_DIR/upgrade-preserve"
mkdir -p "$upgrade_dir"
if run_install --version 0.2.0 --bin-dir "$upgrade_dir" --no-modify-path >/dev/null; then
  bad_stage="${FIXTURE_ROOT}/upgrade-bad-stage"
  mkdir -p "$bad_stage"
  create_fake_am "$bad_stage/am" "0x2x0"
  cp "$ROOT/LICENSE" "$bad_stage/LICENSE"
  cp "$ROOT/crates/cli/README.md" "$bad_stage/README.md"
  good_rel="${FIXTURE_ROOT}/cli/v0.2.0"
  tar -C "$bad_stage" -czf "${good_rel}/am-0.2.0-${TARGET}.tar.gz" am LICENSE README.md
  write_checksums "$good_rel" "0.2.0" "$TARGET"
  set +e
  output="$(run_install --version 0.2.0 --bin-dir "$upgrade_dir" --no-modify-path 2>&1)"
  upgrade_status=$?
  set -e
  [ "$upgrade_status" -ne 0 ] && assert "failed upgrade exits nonzero" true \
    || assert "failed upgrade exits nonzero" false
  case "$output" in
    *'version mismatch'*) assert "failed upgrade reports version mismatch" true ;;
    *) assert "failed upgrade reports version mismatch" false ;;
  esac
  if [ -x "$upgrade_dir/am" ]; then
    got="$("$upgrade_dir/am" --version)"
    [ "$got" = "am 0.2.0" ] && assert "failed upgrade preserves working am" true \
      || assert "failed upgrade preserves working am" false
  else
    assert "failed upgrade preserves working am" false
  fi
  publish_fixture_tarball "0.2.0" "$TARGET"
else
  assert "failed upgrade exits nonzero" false
  assert "failed upgrade reports version mismatch" false
  assert "failed upgrade preserves working am" false
fi

printf '\nCase: checksum mismatch fails closed\n'
bad_dir="${FIXTURE_ROOT}/cli/v9.9.9"
mkdir -p "$bad_dir"
cp "${FIXTURE_ROOT}/cli/v0.2.0/am-0.2.0-${TARGET}.tar.gz" "$bad_dir/am-9.9.9-${TARGET}.tar.gz"
printf 'deadbeef  am-9.9.9-%s.tar.gz\n' "$TARGET" >"$bad_dir/SHA256SUMS"
output="$(AM_BASE_URL="$AM_BASE_URL" AM_VERSION=9.9.9 sh "$INSTALLER" \
  --bin-dir "$BIN_DIR/bad" --no-modify-path 2>&1 || true)"
case "$output" in
  *'checksum mismatch'*) assert "checksum mismatch fails with message" true ;;
  *) assert "checksum mismatch fails with message" false ;;
esac
[ ! -x "$BIN_DIR/bad/am" ] && assert "checksum mismatch does not install binary" true \
  || assert "checksum mismatch does not install binary" false

printf '\nCase: forced attestation verification invokes gh before install\n'
fake_gh_dir="${FIXTURE_ROOT}/fake-gh-bin"
gh_log="${FIXTURE_ROOT}/gh.log"
mkdir -p "$fake_gh_dir"
cat >"${fake_gh_dir}/gh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$GH_LOG"
exit 0
EOF
chmod +x "${fake_gh_dir}/gh"
attest_dir="$BIN_DIR/attest"
if PATH="${fake_gh_dir}:$PATH" GH_LOG="$gh_log" AM_VERIFY_ATTESTATION=1 AM_BASE_URL="$AM_BASE_URL" \
  sh "$INSTALLER" --version 0.2.0 --bin-dir "$attest_dir" --no-modify-path >/dev/null; then
  case "$(cat "$gh_log" 2>/dev/null || true)" in
    *'attestation verify'*'--signer-workflow'*'release-cli.yml'*)
      assert "gh attestation verify is invoked for forced verification" true
      ;;
    *)
      assert "gh attestation verify is invoked for forced verification" false
      ;;
  esac
  [ -x "$attest_dir/am" ] && assert "attested install writes am binary" true \
    || assert "attested install writes am binary" false
else
  assert "gh attestation verify is invoked for forced verification" false
  assert "attested install writes am binary" false
fi

printf '\nCase: uninstall refuses foreign am binary\n'
foreign_am_dir="${BIN_DIR}/foreign-am"
foreign_am_bin="${foreign_am_dir}/am"
mkdir -p "$foreign_am_dir"
printf '#!/bin/sh\nexit 0\n' >"$foreign_am_bin"
chmod +x "$foreign_am_bin"
output="$(AM_INSTALL_DIR="$foreign_am_dir" sh "$INSTALLER" --uninstall 2>&1 || true)"
case "$output" in
  *'refusing to remove foreign'*) assert "uninstall refuses foreign am with message" true ;;
  *) assert "uninstall refuses foreign am with message" false ;;
esac
[ -x "$foreign_am_bin" ] && assert "uninstall leaves foreign am in place" true \
  || assert "uninstall leaves foreign am in place" false

printf '\nCase: uninstall refuses foreign atomicmemory binary\n'
foreign_legacy_dir="${BIN_DIR}/foreign-legacy"
foreign_legacy_bin="${foreign_legacy_dir}/atomicmemory"
mkdir -p "$foreign_legacy_dir"
printf '#!/bin/sh\nexit 0\n' >"$foreign_legacy_bin"
chmod +x "$foreign_legacy_bin"
output="$(AM_INSTALL_DIR="$foreign_legacy_dir" sh "$INSTALLER" --uninstall 2>&1 || true)"
case "$output" in
  *'refusing to remove foreign'*) assert "uninstall refuses foreign atomicmemory with message" true ;;
  *) assert "uninstall refuses foreign atomicmemory with message" false ;;
esac
[ -x "$foreign_legacy_bin" ] && assert "uninstall leaves foreign atomicmemory in place" true \
  || assert "uninstall leaves foreign atomicmemory in place" false

printf '\nCase: install leaves foreign atomicmemory in place\n'
foreign_install_dir="${BIN_DIR}/foreign-install"
mkdir -p "$foreign_install_dir"
printf '#!/bin/sh\nexit 0\n' >"${foreign_install_dir}/atomicmemory"
chmod +x "${foreign_install_dir}/atomicmemory"
if run_install --version 0.2.0 --bin-dir "$foreign_install_dir" --no-modify-path >/dev/null; then
  [ -x "${foreign_install_dir}/atomicmemory" ] && assert "install preserves foreign atomicmemory" true \
    || assert "install preserves foreign atomicmemory" false
  [ -x "${foreign_install_dir}/am" ] && assert "install still writes am binary" true \
    || assert "install still writes am binary" false
else
  assert "install preserves foreign atomicmemory" false
  assert "install still writes am binary" false
fi

printf '\nCase: --no-modify-path next steps mention env file\n'
output="$(run_install --version 0.2.0 --bin-dir "$BIN_DIR/path-msg" --no-modify-path 2>&1 || true)"
case "$output" in
  *atomicmemory/env*) assert "--no-modify-path mentions . env activation" true ;;
  *) assert "--no-modify-path mentions . env activation" false ;;
esac

printf '\nCase: install always writes ~/.atomicmemory/env\n'
env_dir="${FIXTURE_ROOT}/home-env"
HOME="$env_dir" run_install --version 0.2.0 --bin-dir "$BIN_DIR/env-always" --no-modify-path >/dev/null
[ -f "$env_dir/.atomicmemory/env" ] && assert "install writes env file even with --no-modify-path" true \
  || assert "install writes env file even with --no-modify-path" false

printf '\nCase: --init runs am init in install subshell\n'
output="$(run_install --version 0.2.0 --bin-dir "$BIN_DIR/init-flag" --no-modify-path --init 2>&1 || true)"
case "$output" in
  *'ran am init'*) assert "--init reports am init ran" true ;;
  *) assert "--init reports am init ran" false ;;
esac

printf '\nCase: requested environment failure fails install\n'
set +e
output="$(run_install --version 0.2.0 --bin-dir "$BIN_DIR/env-fail" --no-modify-path --env invalid 2>&1)"
env_status=$?
set -e
[ "$env_status" -ne 0 ] && assert "--env failure exits nonzero" true \
  || assert "--env failure exits nonzero" false
case "$output" in
  *"could not seed environment preset 'invalid'"*) assert "--env failure fails with message" true ;;
  *) assert "--env failure fails with message" false ;;
esac

printf '\nCase: requested core-image failure fails install\n'
set +e
output="$(run_install --version 0.2.0 --bin-dir "$BIN_DIR/image-fail" --no-modify-path --core-image bad-image 2>&1)"
image_status=$?
set -e
[ "$image_status" -ne 0 ] && assert "--core-image failure exits nonzero" true \
  || assert "--core-image failure exits nonzero" false
case "$output" in
  *"could not seed Core image override 'bad-image'"*) assert "--core-image failure fails with message" true ;;
  *) assert "--core-image failure fails with message" false ;;
esac

printf '\nResults: %s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  exit 1
fi
