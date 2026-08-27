#!/bin/sh
# Internal eng-team installer for prebuilt `am` from private GitHub Releases
# on atomicstrata/atomicmemory-internal.
#
# Not the public distribution channel. Requires an authenticated GitHub CLI.
# Bootstrap into a private temp dir (never a predictable /tmp/install.sh):
#
#   tmp="$(mktemp -d)" && \
#   gh release download cli-internal-latest \
#     --repo atomicstrata/atomicmemory-internal \
#     --pattern install.sh \
#     --dir "$tmp" \
#     && sh "$tmp/install.sh"
#
# Optional:
#   AM_INTERNAL_TAG=cli-internal-<sha>   pin a specific internal release
#   AM_INTERNAL_REPO=owner/repo          override source repo (tests)
#   AM_INSTALL_DIR / --bin-dir           same as scripts/install-cli.sh
set -eu

AM_INTERNAL_REPO="${AM_INTERNAL_REPO:-atomicstrata/atomicmemory-internal}"
AM_INTERNAL_TAG="${AM_INTERNAL_TAG:-cli-internal-latest}"
AM_DIST_DEFAULT_BASE_URL="https://get.atomicstrata.ai"

info() { printf '%s\n' "$*" >&2; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

have gh || err "need GitHub CLI (gh) on PATH; run: gh auth login"
have curl || err "need curl on PATH"
have tar || err "need tar on PATH"

case "$AM_INTERNAL_TAG" in
  cli-v* | v[0-9]* | [0-9]*.[0-9]*.[0-9]*)
    err "refusing public release tag '${AM_INTERNAL_TAG}'; use cli-internal-latest or cli-internal-<sha>"
    ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/am-internal.XXXXXX")" || err "mktemp failed"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

info "info: downloading internal release ${AM_INTERNAL_TAG} from ${AM_INTERNAL_REPO}"
gh release download "$AM_INTERNAL_TAG" \
  --repo "$AM_INTERNAL_REPO" \
  --dir "$TMP" \
  --pattern 'am-*.tar.gz' \
  --pattern SHA256SUMS \
  --pattern version.json \
  --pattern install-cli.sh \
  || err "gh release download failed for ${AM_INTERNAL_TAG} (are you authenticated for ${AM_INTERNAL_REPO}?)"

version_json="${TMP}/version.json"
[ -f "$version_json" ] || err "version.json missing from release ${AM_INTERNAL_TAG}"

AM_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$version_json" | head -n1)"
[ -n "$AM_VERSION" ] || err "could not parse version from version.json"
if ! printf '%s' "$AM_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  err "invalid version in version.json: ${AM_VERSION} (expected X.Y.Z)"
fi

rel_dir="${TMP}/mirror/cli/v${AM_VERSION}"
mkdir -p "$rel_dir"
mv "$TMP"/am-*.tar.gz "$rel_dir/"
mv "$TMP/SHA256SUMS" "$rel_dir/"
mv "$version_json" "${TMP}/mirror/version.json"

# Always use the authenticated release asset. Never prefer a sibling
# install-cli.sh beside this wrapper (e.g. stale /tmp/install-cli.sh).
installer="${TMP}/install-cli.sh"
[ -f "$installer" ] || err "install-cli.sh missing from release ${AM_INTERNAL_TAG}"

# Public installer automatically verifies authenticated get.atomicstrata.ai
# downloads; this channel has no attestations and must never hit that mirror.
export AM_BASE_URL="file://${TMP}/mirror"
export AM_VERIFY_ATTESTATION=0
export AM_VERSION

info "info: installing am ${AM_VERSION} from internal channel (${AM_INTERNAL_TAG})"
sh "$installer" "$@"
