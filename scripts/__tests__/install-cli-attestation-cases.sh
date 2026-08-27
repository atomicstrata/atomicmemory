#!/usr/bin/env bash
# Attestation-mode contract cases sourced by install-cli.test.sh.

auto_installer="${FIXTURE_ROOT}/install-cli-auto.sh"
sed "s|^AM_DIST_DEFAULT_BASE_URL=.*|AM_DIST_DEFAULT_BASE_URL=\"$AM_BASE_URL\"|" \
  "$INSTALLER" >"$auto_installer"

logged_out_gh_dir="${FIXTURE_ROOT}/logged-out-gh-bin"
logged_out_gh_log="${FIXTURE_ROOT}/logged-out-gh.log"
mkdir -p "$logged_out_gh_dir"
cat >"${logged_out_gh_dir}/gh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$GH_LOG"
[ "$1 $2" = "auth token" ] && exit 1
[ "$1 $2" = "attestation verify" ] && exit 73
exit 0
EOF
chmod +x "${logged_out_gh_dir}/gh"

printf '\nCase: automatic attestation skips logged-out GitHub CLI\n'
auto_logged_out_dir="$BIN_DIR/attest-auto-logged-out"
set +e
output="$(PATH="${logged_out_gh_dir}:$PATH" GH_LOG="$logged_out_gh_log" \
  AM_VERIFY_ATTESTATION=auto AM_BASE_URL="$AM_BASE_URL" sh "$auto_installer" \
  --version 0.2.0 --bin-dir "$auto_logged_out_dir" --no-modify-path 2>&1)"
auto_logged_out_status=$?
set -e
[ "$auto_logged_out_status" -eq 0 ] \
  && assert "auto mode continues when gh is logged out" true \
  || assert "auto mode continues when gh is logged out" false
case "$output" in
  *'GitHub CLI is not authenticated; continuing with checksum verification only'*)
    assert "auto mode explains checksum-only verification" true
    ;;
  *) assert "auto mode explains checksum-only verification" false ;;
esac
grep -qx 'auth token' "$logged_out_gh_log" 2>/dev/null \
  && assert "auto mode checks GitHub CLI authentication" true \
  || assert "auto mode checks GitHub CLI authentication" false
if grep -q '^attestation verify' "$logged_out_gh_log" 2>/dev/null; then
  assert "auto mode does not attempt attestation while logged out" false
else
  assert "auto mode does not attempt attestation while logged out" true
fi
[ -x "$auto_logged_out_dir/am" ] \
  && assert "auto logged-out mode installs checksum-verified binary" true \
  || assert "auto logged-out mode installs checksum-verified binary" false

printf '\nCase: required attestation fails closed when GitHub CLI is logged out\n'
: >"$logged_out_gh_log"
required_logged_out_dir="$BIN_DIR/attest-required-logged-out"
set +e
output="$(PATH="${logged_out_gh_dir}:$PATH" GH_LOG="$logged_out_gh_log" \
  AM_VERIFY_ATTESTATION=1 AM_BASE_URL="$AM_BASE_URL" sh "$INSTALLER" \
  --version 0.2.0 --bin-dir "$required_logged_out_dir" --no-modify-path 2>&1)"
required_logged_out_status=$?
set -e
[ "$required_logged_out_status" -ne 0 ] \
  && assert "required mode fails when gh is logged out" true \
  || assert "required mode fails when gh is logged out" false
case "$output" in
  *'GitHub CLI authentication is required for attestation verification'*)
    assert "required mode explains GitHub authentication requirement" true
    ;;
  *) assert "required mode explains GitHub authentication requirement" false ;;
esac
if grep -q '^attestation verify' "$logged_out_gh_log" 2>/dev/null; then
  assert "required mode stops before unauthenticated attestation request" false
else
  assert "required mode stops before unauthenticated attestation request" true
fi
[ ! -x "$required_logged_out_dir/am" ] \
  && assert "required logged-out mode does not install binary" true \
  || assert "required logged-out mode does not install binary" false

printf '\nCase: automatic attestation uses authenticated GitHub CLI\n'
authenticated_gh_dir="${FIXTURE_ROOT}/authenticated-gh-bin"
authenticated_gh_log="${FIXTURE_ROOT}/authenticated-gh.log"
mkdir -p "$authenticated_gh_dir"
cat >"${authenticated_gh_dir}/gh" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$GH_LOG"
exit 0
EOF
chmod +x "${authenticated_gh_dir}/gh"
auto_authenticated_dir="$BIN_DIR/attest-auto-authenticated"
if PATH="${authenticated_gh_dir}:$PATH" GH_LOG="$authenticated_gh_log" \
  AM_VERIFY_ATTESTATION=auto AM_BASE_URL="$AM_BASE_URL" sh "$auto_installer" \
  --version 0.2.0 --bin-dir "$auto_authenticated_dir" --no-modify-path >/dev/null; then
  case "$(cat "$authenticated_gh_log" 2>/dev/null || true)" in
    *'auth token'*'attestation verify'*'--signer-workflow'*'release-cli.yml'*)
      assert "auto mode verifies with authenticated gh" true
      ;;
    *) assert "auto mode verifies with authenticated gh" false ;;
  esac
  [ -x "$auto_authenticated_dir/am" ] \
    && assert "auto authenticated mode installs attested binary" true \
    || assert "auto authenticated mode installs attested binary" false
else
  assert "auto mode verifies with authenticated gh" false
  assert "auto authenticated mode installs attested binary" false
fi

printf '\nCase: forced attestation verification invokes gh before install\n'
: >"$authenticated_gh_log"
attest_dir="$BIN_DIR/attest"
if PATH="${authenticated_gh_dir}:$PATH" GH_LOG="$authenticated_gh_log" \
  AM_VERIFY_ATTESTATION=1 AM_BASE_URL="$AM_BASE_URL" sh "$INSTALLER" \
  --version 0.2.0 --bin-dir "$attest_dir" --no-modify-path >/dev/null; then
  case "$(cat "$authenticated_gh_log" 2>/dev/null || true)" in
    *'auth token'*'attestation verify'*'--signer-workflow'*'release-cli.yml'*)
      assert "gh attestation verify is invoked for forced verification" true
      ;;
    *) assert "gh attestation verify is invoked for forced verification" false ;;
  esac
  [ -x "$attest_dir/am" ] && assert "attested install writes am binary" true \
    || assert "attested install writes am binary" false
else
  assert "gh attestation verify is invoked for forced verification" false
  assert "attested install writes am binary" false
fi
