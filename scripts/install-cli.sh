#!/bin/sh
# AtomicMemory CLI installer.
#
# Canonical release artifacts: GitHub Releases on atomicstrata/atomicmemory
# (checksums + build provenance attestations). Default downloads use the
# mirrored convenience channel at get.atomicstrata.ai (same digests).
#
#   curl -fsSL https://get.atomicstrata.ai/install.sh | sh
set -eu

# --- configuration (override via env for testing) ---------------------------
# AM_DIST_DEFAULT_BASE_URL is the public mirror base URL baked into release
# install.sh and promoted byte-identically to get.atomicstrata.ai.
# Override at runtime with AM_BASE_URL=...
AM_DIST_DEFAULT_BASE_URL="https://get.atomicstrata.ai"
AM_BASE_URL="${AM_BASE_URL:-$AM_DIST_DEFAULT_BASE_URL}"
AM_INSTALL_DIR="${AM_INSTALL_DIR:-}"
AM_VERSION="${AM_VERSION:-}"
AM_NO_MODIFY_PATH="${AM_NO_MODIFY_PATH:-0}"
AM_ENVIRONMENT="${AM_ENVIRONMENT:-}"
AM_CORE_IMAGE="${AM_CORE_IMAGE:-}"
AM_VERIFY_ATTESTATION="${AM_VERIFY_ATTESTATION:-auto}"
AM_ENV_DIR="${HOME}/.atomicmemory"
AM_UNINSTALL=0
AM_INIT=0
USE_SUDO=0

info() { printf '%s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# True when $1 is this project's CLI (not another Unix tool named `am`).
is_our_am() {
  cmd="$1"
  [ -n "$cmd" ] && [ -x "$cmd" ] || return 1
  about="$("$cmd" --help 2>/dev/null | head -n1 || true)"
  case "$about" in
    *AtomicMemory*) return 0 ;;
  esac
  ver="$("$cmd" --version 2>/dev/null || true)"
  case "$ver" in
    am\ [0-9]* | atomicmemory\ [0-9]*) return 0 ;;
  esac
  return 1
}

# True when $1 is AppMan / AM (Linux AppImage package manager), a common `am` on PATH.
is_appman_am() {
  cmd="$1"
  [ -n "$cmd" ] || return 1
  if [ -L "$cmd" ]; then
    target="$(readlink "$cmd" 2>/dev/null || true)"
    case "$target" in
      */APP-MANAGER | */opt/am/*) return 0 ;;
    esac
  fi
  if command -v realpath >/dev/null 2>&1; then
    resolved="$(realpath "$cmd" 2>/dev/null || true)"
    case "$resolved" in
      */opt/am/APP-MANAGER | */APP-MANAGER) return 0 ;;
    esac
  fi
  if [ -f /opt/am/APP-MANAGER ] && [ "$cmd" = "/usr/local/bin/am" ]; then
    return 0
  fi
  if [ -f /usr/bin/am ] && [ "$cmd" = "/usr/bin/am" ] && [ -d /usr/lib/am/modules ]; then
    return 0
  fi
  if head -n1 "$cmd" 2>/dev/null | grep -qE '^#!.*(bash|sh)'; then
    if grep -q 'APP-MANAGER\|AppMan\|APPLICATION-MANAGER' "$cmd" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

foreign_am_label() {
  cmd="$1"
  if is_appman_am "$cmd"; then
    printf '%s' "AppMan (Linux AppImage manager)"
  else
    printf '%s' "unknown program"
  fi
}

remove_binary_if_allowed() {
  path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 1
  if ! is_our_am "$path"; then
    if [ "${AM_FORCE:-0}" != "1" ]; then
      err "refusing to remove foreign ${path} ($(foreign_am_label "$path")). Set AM_FORCE=1 to override."
    fi
    warn "removing foreign ${path} ($(foreign_am_label "$path")) because AM_FORCE=1"
  fi
  rm -f "$path"
  return 0
}

assert_am_version() {
  bin="$1"
  expected_ver="$2"
  got="$("$bin" --version 2>/dev/null || true)"
  expected="am ${expected_ver}"
  [ "$got" = "$expected" ]
}

validate_version_string() {
  v="$1"
  if ! printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    err "invalid version: ${v} (expected X.Y.Z)"
  fi
}

# Fail closed on musl Linux until a dedicated musl artifact exists.
reject_musl_linux() {
  [ "$(uname -s)" = "Linux" ] || return 0
  if ls /lib/ld-musl-* >/dev/null 2>&1; then
    err "musl-based Linux is not supported yet (glibc binary only). Build from source with: cargo install --path crates/cli --force"
  fi
  if command -v ldd >/dev/null 2>&1; then
    if ldd /bin/sh 2>/dev/null | grep -Eiq 'musl|ld-musl'; then
      err "musl-based Linux is not supported yet (glibc binary only). Build from source with: cargo install --path crates/cli --force"
    fi
  fi
}

# Refuse to overwrite a foreign `am` unless AM_FORCE=1.
validate_install_target() {
  dir="$1"
  target="${dir}/am"
  [ -f "$target" ] || return 0
  is_our_am "$target" && return 0
  label="$(foreign_am_label "$target")"
  if [ "${AM_FORCE:-0}" = "1" ]; then
    warn "overwriting ${target} (${label}) because AM_FORCE=1"
    return 0
  fi
  err "refusing to overwrite ${target} (${label}). Install elsewhere, e.g.:
  curl -fsSL https://get.atomicstrata.ai/install.sh | sh -s -- --bin-dir \"\$HOME/.local/bin\"
Or set AM_FORCE=1 to overwrite (breaks the other tool's \`am\` command)."
}

usage() {
  cat >&2 <<'EOF'
AtomicMemory CLI installer

Usage:
  install.sh [--version <X.Y.Z>] [--bin-dir <dir>] [--system]

Options:
  --version <X.Y.Z>   Install a specific version (default: latest from version.json)
  --bin-dir <dir>     Install directory (default: $HOME/.local/bin)
  --system            Install to /usr/local/bin (uses sudo if needed)
  --no-modify-path    Do not edit shell startup files to update PATH
  --env <prod|staging|dev>
                      Seed CLI environment preset after install (default: built-in prod)
  --core-image <ref>  Seed Core Docker image override after install
  --init              Run am init after install (uses ~/.atomicmemory/env in this subshell)
  --uninstall, -r     Remove am (and legacy atomicmemory binary if present)
  -h, --help          Show this help

Environment:
  AM_BASE_URL         Distribution origin (default: https://get.atomicstrata.ai)
  AM_INSTALL_DIR      Same as --bin-dir
  AM_VERSION          Same as --version
  AM_NO_MODIFY_PATH   Set to 1 for --no-modify-path
  AM_ENVIRONMENT      Same as --env (assign on sh, not curl: AM_ENVIRONMENT=staging sh)
  AM_CORE_IMAGE       Same as --core-image
  AM_FORCE            Set to 1 to overwrite an existing foreign `am` binary (e.g. AppMan)
  AM_VERIFY_ATTESTATION
                     auto|1|0 (default: auto). auto verifies public mirror downloads
                     when gh is available; 1 requires gh attestation verification.

Trust: release artifacts are built from github.com/atomicstrata/atomicmemory.
SHA256SUMS verifies integrity against the mirror; it does not authenticate the publisher.
For attestation verification use:
  gh attestation verify ./am-X.Y.Z-<target>.tar.gz \
    --repo atomicstrata/atomicmemory \
    --signer-workflow atomicstrata/atomicmemory/.github/workflows/release-cli.yml \
    --source-ref refs/tags/cli-vX.Y.Z

Note: On Linux, AppMan/AM (AppImage manager) may already install `am` under /usr/local/bin
or /usr/bin. The installer skips those directories and prefers ~/.local/bin instead.
EOF
}

main() {
# --- argument parsing --------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || err "--version requires a value"
      AM_VERSION="$2"
      shift 2
      ;;
    --version=*)
      AM_VERSION="${1#*=}"
      shift
      ;;
    --bin-dir)
      [ $# -ge 2 ] || err "--bin-dir requires a value"
      AM_INSTALL_DIR="$2"
      shift 2
      ;;
    --bin-dir=*)
      AM_INSTALL_DIR="${1#*=}"
      shift
      ;;
    --system)
      AM_INSTALL_DIR="${AM_INSTALL_DIR:-/usr/local/bin}"
      shift
      ;;
    --no-modify-path)
      AM_NO_MODIFY_PATH=1
      shift
      ;;
    --env)
      [ $# -ge 2 ] || err "--env requires a value (prod, staging, or dev)"
      AM_ENVIRONMENT="$2"
      shift 2
      ;;
    --env=*)
      AM_ENVIRONMENT="${1#*=}"
      shift
      ;;
    --core-image)
      [ $# -ge 2 ] || err "--core-image requires a value"
      AM_CORE_IMAGE="$2"
      shift 2
      ;;
    --core-image=*)
      AM_CORE_IMAGE="${1#*=}"
      shift
      ;;
    --init)
      AM_INIT=1
      shift
      ;;
    --uninstall | --remove | -r)
      AM_UNINSTALL=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      err "unknown argument: $1 (try --help)"
      ;;
  esac
done

# strip a leading "v" / "cli-v" if a tag was passed instead of a bare version
AM_VERSION="${AM_VERSION#cli-}"
AM_VERSION="${AM_VERSION#v}"

# --- uninstall ---------------------------------------------------------------
run_uninstall() {
  dir="${AM_INSTALL_DIR:-$HOME/.local/bin}"
  mb="# >>> atomicmemory >>>"
  me="# <<< atomicmemory <<<"
  any=0

  for f in am atomicmemory; do
    if remove_binary_if_allowed "$dir/$f"; then
      info "  removed $dir/$f"
      any=1
    fi
  done

  # strip the PATH block from common shell startup files
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.config/fish/config.fish"; do
    [ -f "$rc" ] || continue
    if grep -qF "$mb" "$rc" 2>/dev/null && command -v awk >/dev/null 2>&1; then
      tmp="${rc}.atomicmemory.tmp"
      if awk -v b="$mb" -v e="$me" '
        $0==b{skip=1; next}
        $0==e{skip=0; next}
        skip{next}
        {print}
      ' "$rc" >"$tmp"; then
        mv "$tmp" "$rc" && { info "  removed PATH entry from $rc"; any=1; }
      else
        rm -f "$tmp"
      fi
    fi
  done

  if [ -d "$AM_ENV_DIR" ]; then
    rm -f "${AM_ENV_DIR}/env" "${AM_ENV_DIR}/env.fish"
    rmdir "$AM_ENV_DIR" 2>/dev/null || true
    [ -e "${AM_ENV_DIR}/env" ] || { info "  removed ${AM_ENV_DIR}/env"; any=1; }
  fi

  [ "$any" -eq 1 ] || info "  nothing to remove (am not found under ${dir})"

  case "$(uname -s)" in
    Darwin) cfg="$HOME/Library/Application Support/ai.atomicstrata.atomicmemory" ;;
    *) cfg="${XDG_CONFIG_HOME:-$HOME/.config}/atomicmemory" ;;
  esac
  info ""
  info "  Profiles/credentials were left intact. To remove them too:"
  info "    rm -rf \"${cfg}\""
  info ""
  info "  Restart your shell to drop am from PATH."
}

if [ "$AM_UNINSTALL" = "1" ]; then
  info ""
  info "Uninstalling am…"
  run_uninstall
  exit 0
fi

# --- dependency checks -------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

if have curl; then
  DL="curl -fsSL"
  DL_OUT="curl -fsSL -o"
elif have wget; then
  DL="wget -qO-"
  DL_OUT="wget -qO"
else
  err "need curl or wget on PATH"
fi

if have sha256sum; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  err "need sha256sum or shasum on PATH"
fi

have tar || err "need tar on PATH"

should_verify_attestation() {
  case "$AM_VERIFY_ATTESTATION" in
    1 | true | TRUE | yes | YES | on | ON)
      return 0
      ;;
    0 | false | FALSE | no | NO | off | OFF)
      return 1
      ;;
    auto | AUTO | "")
      [ "$AM_BASE_URL" = "$AM_DIST_DEFAULT_BASE_URL" ] && have gh
      return
      ;;
    *)
      err "invalid AM_VERIFY_ATTESTATION: ${AM_VERIFY_ATTESTATION} (expected auto, 1, or 0)"
      ;;
  esac
}

verify_release_attestation() {
  should_verify_attestation || return 0
  have gh || err "gh is required for attestation verification (install GitHub CLI or set AM_VERIFY_ATTESTATION=0)"
  info "info: verifying GitHub artifact attestation"
  gh attestation verify "${TMP}/${TARBALL}" \
    --repo atomicstrata/atomicmemory \
    --signer-workflow atomicstrata/atomicmemory/.github/workflows/release-cli.yml \
    --source-ref "refs/tags/cli-v${AM_VERSION}" >/dev/null \
    || err "attestation verification failed for ${TARBALL}"
  info "info: attestation verified"
}

# --- platform detection ------------------------------------------------------
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os_part="unknown-linux-gnu" ;;
    Darwin) os_part="apple-darwin" ;;
    *) err "unsupported OS: $os (supported: Linux, Darwin)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch_part="x86_64" ;;
    arm64 | aarch64) arch_part="aarch64" ;;
    *) err "unsupported CPU arch: $arch (supported: x86_64, arm64)" ;;
  esac
  printf '%s-%s' "$arch_part" "$os_part"
}

TARGET="$(detect_target)"
reject_musl_linux

# --- prefer a writable bin dir already on PATH --------------------------------
dir_on_path() {
  dir="$1"
  [ -n "$dir" ] || return 1
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
    *) return 1 ;;
  esac
}

writable_dir() {
  dir="$1"
  [ -n "$dir" ] || return 1
  [ -d "$dir" ] && [ -w "$dir" ] && return 0
  mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]
}

prefer_install_dir() {
  if [ -n "$AM_INSTALL_DIR" ]; then
    printf '%s' "$AM_INSTALL_DIR"
    return
  fi
  for dir in \
    "${HOME}/.local/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    if dir_on_path "$dir" && writable_dir "$dir"; then
      if [ -f "${dir}/am" ] && ! is_our_am "${dir}/am"; then
        label="$(foreign_am_label "${dir}/am")"
        warn "skipping ${dir}: another 'am' is already installed (${label})"
        continue
      fi
      printf '%s' "$dir"
      return
    fi
  done
  printf '%s' "${HOME}/.local/bin"
}

# --- PATH persistence --------------------------------------------------------
AM_MARKER_BEGIN="# >>> atomicmemory >>>"
AM_MARKER_END="# <<< atomicmemory <<<"
PATH_RC_FILE=""
PATH_RC_ACTION=""
PATH_ENV_FILE=""
SHELL_RC_CONFIGURED=0

write_env_files() {
  bindir="$1"
  mkdir -p "$AM_ENV_DIR" 2>/dev/null || return 1

  posix="${AM_ENV_DIR}/env"
  {
    printf '%s\n' "# atomicmemory shell environment (managed by install-cli.sh; safe to delete)"
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$bindir"
    printf '  *) export PATH="%s:$PATH" ;;\n' "$bindir"
    printf 'esac\n'
  } >"$posix" || return 1
  PATH_ENV_FILE="$posix"

  fishf="${AM_ENV_DIR}/env.fish"
  {
    printf '%s\n' "# atomicmemory shell environment (managed by install-cli.sh; safe to delete)"
    printf 'if not contains "%s" $PATH\n' "$bindir"
    printf '  set -gx PATH "%s" $PATH\n' "$bindir"
    printf 'end\n'
  } >"$fishf" 2>/dev/null || true

  return 0
}

rc_file_for_shell() {
  name="$(basename "${SHELL:-}")"
  case "$name" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bash_profile" ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi
      ;;
    fish) printf '%s' "$HOME/.config/fish/config.fish" ;;
    *) printf '' ;;
  esac
}

configure_shell_path() {
  bindir="$1"
  command -v awk >/dev/null 2>&1 || return 1
  rc="$(rc_file_for_shell)"
  [ -n "$rc" ] || return 1

  case "$(basename "${SHELL:-}")" in
    fish) line="source \"${AM_ENV_DIR}/env.fish\"" ;;
    *) line=". \"${AM_ENV_DIR}/env\"" ;;
  esac

  mkdir -p "$(dirname "$rc")" 2>/dev/null || return 1
  if [ -e "$rc" ] && { [ ! -f "$rc" ] || [ ! -w "$rc" ]; }; then
    return 1
  fi

  if [ -f "$rc" ] && grep -qF "$AM_MARKER_BEGIN" "$rc"; then
    PATH_RC_ACTION="Updated"
  elif [ -f "$rc" ]; then
    PATH_RC_ACTION="Added"
  else
    PATH_RC_ACTION="Created"
  fi

  tmp="${rc}.atomicmemory.tmp"
  if [ -f "$rc" ]; then
    awk -v b="$AM_MARKER_BEGIN" -v e="$AM_MARKER_END" '
      $0==b{skip=1; next}
      $0==e{skip=0; next}
      skip{next}
      {print}
    ' "$rc" >"$tmp" || { rm -f "$tmp"; return 1; }
  else
    : >"$tmp"
  fi

  {
    printf '\n%s\n' "$AM_MARKER_BEGIN"
    printf '%s\n' "$line"
    printf '%s\n' "$AM_MARKER_END"
  } >>"$tmp"

  mv "$tmp" "$rc" || { rm -f "$tmp"; return 1; }
  PATH_RC_FILE="$rc"
  SHELL_RC_CONFIGURED=1
  return 0
}

activate_install_path() {
  if [ -f "${PATH_ENV_FILE:-$AM_ENV_DIR/env}" ]; then
    # shellcheck disable=SC1090
    . "${PATH_ENV_FILE:-$AM_ENV_DIR/env}"
  elif [ -n "${AM_INSTALL_DIR:-}" ]; then
    PATH="${AM_INSTALL_DIR}:${PATH}"
    export PATH
  fi
}

# --- resolve version ---------------------------------------------------------
if [ -z "$AM_VERSION" ]; then
  info "info: resolving latest version from ${AM_BASE_URL}/version.json"
  version_json="$($DL "${AM_BASE_URL}/version.json")" \
    || err "could not fetch ${AM_BASE_URL}/version.json"
  AM_VERSION="$(printf '%s' "$version_json" \
    | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n1)"
  [ -n "$AM_VERSION" ] || err "could not parse version from version.json"
fi

validate_version_string "$AM_VERSION"

TARBALL="am-${AM_VERSION}-${TARGET}.tar.gz"
REL_URL="${AM_BASE_URL}/cli/v${AM_VERSION}"

# --- resolve install dir -----------------------------------------------------
if [ -z "$AM_INSTALL_DIR" ]; then
  AM_INSTALL_DIR="$(prefer_install_dir)"
fi
validate_install_target "$AM_INSTALL_DIR"
case "$AM_INSTALL_DIR" in
  /usr/* | /opt/*) USE_SUDO=1 ;;
esac
if [ "$USE_SUDO" -eq 1 ] && [ ! -w "$AM_INSTALL_DIR" ] && [ "$(id -u)" -ne 0 ]; then
  have sudo || err "installing to $AM_INSTALL_DIR needs root; install sudo or use --bin-dir"
  SUDO="sudo"
else
  SUDO=""
fi

# --- download + verify -------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atomicmemory.XXXXXX")" || err "mktemp failed"
trap 'rm -rf "$TMP"' EXIT INT TERM

info "info: downloading ${TARBALL} (${AM_VERSION}, ${TARGET})"
$DL_OUT "${TMP}/${TARBALL}" "${REL_URL}/${TARBALL}" \
  || err "download failed: ${REL_URL}/${TARBALL}"
$DL_OUT "${TMP}/SHA256SUMS" "${REL_URL}/SHA256SUMS" \
  || err "download failed: ${REL_URL}/SHA256SUMS"

expected="$(grep " ${TARBALL}\$" "${TMP}/SHA256SUMS" | cut -d' ' -f1 | head -n1)"
[ -n "$expected" ] || err "${TARBALL} not listed in SHA256SUMS"
actual="$(sha256_of "${TMP}/${TARBALL}")"
if [ "$expected" != "$actual" ]; then
  err "checksum mismatch for ${TARBALL} (expected ${expected}, got ${actual})"
fi
info "info: checksum verified (${actual})"
verify_release_attestation

# --- extract + install -------------------------------------------------------
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}" || err "extract failed"
bin_src="${TMP}/am"
[ -f "$bin_src" ] || bin_src="$(find "$TMP" -type f -name am | head -n1)"
[ -n "$bin_src" ] && [ -f "$bin_src" ] || err "am binary not found in tarball"

$SUDO mkdir -p "$AM_INSTALL_DIR" || err "cannot create $AM_INSTALL_DIR"

tmp_bin="${AM_INSTALL_DIR}/.am.install.$$"
$SUDO install -m 0755 "$bin_src" "$tmp_bin" || err "install failed to ${AM_INSTALL_DIR}"
if ! is_our_am "$tmp_bin"; then
  $SUDO rm -f "$tmp_bin"
  err "installed binary failed identity check"
fi
if ! assert_am_version "$tmp_bin" "$AM_VERSION"; then
  $SUDO rm -f "$tmp_bin"
  err "installed binary version mismatch (expected am ${AM_VERSION})"
fi
$SUDO mv "$tmp_bin" "${AM_INSTALL_DIR}/am" \
  || err "atomic install failed to ${AM_INSTALL_DIR}"

legacy_bin="${AM_INSTALL_DIR}/atomicmemory"
if [ -e "$legacy_bin" ] || [ -L "$legacy_bin" ]; then
  if is_our_am "$legacy_bin"; then
    $SUDO rm -f "$legacy_bin"
  fi
fi

info ""
info "  installed am ${AM_VERSION} -> ${AM_INSTALL_DIR}/am"

if ! write_env_files "$AM_INSTALL_DIR"; then
  warn "could not write ${AM_ENV_DIR}/env"
else
  PATH_ENV_FILE="${AM_ENV_DIR}/env"
fi

# --- PATH persistence + shadow detection -------------------------------------
on_path=0
case ":${PATH}:" in
  *":${AM_INSTALL_DIR}:"*) on_path=1 ;;
esac

existing="$(command -v am 2>/dev/null || true)"
shadow=""
if [ -n "$existing" ] && [ "$existing" != "${AM_INSTALL_DIR}/am" ]; then
  shadow="$existing"
fi

needs_path=0
[ "$on_path" -eq 0 ] && needs_path=1
[ -n "$shadow" ] && needs_path=1

if [ "$needs_path" -eq 1 ]; then
  if [ "$AM_NO_MODIFY_PATH" = "1" ]; then
    info ""
    info "  Add ${AM_INSTALL_DIR} to the FRONT of your PATH:"
    info "    . \"${AM_ENV_DIR}/env\""
    info "  or: export PATH=\"${AM_INSTALL_DIR}:\$PATH\""
  elif configure_shell_path "$AM_INSTALL_DIR"; then
    info ""
    info "  ${PATH_RC_ACTION} PATH entry in ${PATH_RC_FILE}"
    info "  Activate it now with:"
    info "    . \"${PATH_ENV_FILE:-$AM_ENV_DIR/env}\""
  else
    info ""
    info "  Could not update your shell startup file automatically."
    info "  Activate PATH now with:"
    info "    . \"${AM_ENV_DIR}/env\""
    info "  or: export PATH=\"${AM_INSTALL_DIR}:\$PATH\""
  fi
fi

if [ -n "$shadow" ]; then
  shadow_label="$(foreign_am_label "$shadow")"
  info ""
  info "  note: another 'am' is currently first on your PATH:"
  info "    ${shadow} (${shadow_label})"
  if is_appman_am "$shadow"; then
    info "  AppMan uses \`am\` on Linux; AtomicMemory CLI was installed as:"
    info "    ${AM_INSTALL_DIR}/am"
    info "  Source ~/.atomicmemory/env (or restart your shell) so this install wins."
    info "  AppMan's local mode uses the \`appman\` command — no rename needed."
  else
    info "  It will keep shadowing the new build until you restart your shell"
    info "  (or 'source' the line above). To remove an old cargo build:"
    info "    cargo uninstall atomicmemory  # crate name; binary is am"
  fi
fi

info ""

if [ -n "$AM_ENVIRONMENT" ]; then
  "${AM_INSTALL_DIR}/am" --quiet config env use "$AM_ENVIRONMENT" \
    || err "could not seed environment preset '${AM_ENVIRONMENT}'"
  info "  seeded environment preset: ${AM_ENVIRONMENT}"
fi

if [ -n "$AM_CORE_IMAGE" ]; then
  activate_install_path
  "${AM_INSTALL_DIR}/am" --quiet config set core-image "$AM_CORE_IMAGE" \
    || err "could not seed Core image override '${AM_CORE_IMAGE}'"
  info "  seeded Core image override: ${AM_CORE_IMAGE}"
fi

if [ "$AM_INIT" = "1" ]; then
  activate_install_path
  "${AM_INSTALL_DIR}/am" init \
    || err "am init failed (run: . \"${AM_ENV_DIR}/env\" && am init)"
  info "  ran am init"
fi

info ""
if [ "$AM_INIT" = "1" ]; then
  info "  Next: am integrate --help"
elif [ "$SHELL_RC_CONFIGURED" = "1" ]; then
  # The rc entry only applies to future shells, so offer the same-session
  # activation too: the documented quickstart runs `am init` right away.
  info "  Next (same session): . \"${PATH_ENV_FILE:-$AM_ENV_DIR/env}\" && am init"
  info "  or open a new terminal, then run: am init"
elif [ "$needs_path" -eq 1 ]; then
  info "  Next (same session): . \"${AM_ENV_DIR}/env\" && am init"
else
  info "  Next: am init"
fi
info ""

assert_am_version "${AM_INSTALL_DIR}/am" "$AM_VERSION" \
  || err "installed binary failed final version check"
}

main "$@"
