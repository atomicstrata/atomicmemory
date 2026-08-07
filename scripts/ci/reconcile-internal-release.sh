#!/usr/bin/env bash
# Reconcile a rerun of the Internal CLI Release workflow against the
# existing immutable cli-internal-<sha> release, if any.
#
# Called from .github/workflows/internal-cli-release.yml. Because
# rebuilt tarballs are NOT byte-reproducible (tar embeds mtimes), a
# rerun of the same source SHA cannot rely on locally rebuilt bytes
# matching the ones already published under cli-internal-<sha>. The
# immutable release is the source of truth on rerun.
#
# Behavior:
#   1. If the immutable tag has no release yet, print
#      release_exists=false and exit 0 so the caller creates it.
#   2. If a release exists, verify its target commit equals $SHA and
#      its asset-name set equals the locally rebuilt set. Either
#      mismatch fails closed - immutable releases must never be
#      silently repointed or accept a divergent manifest.
#   3. When both match, download the release's actual assets, verify
#      the downloaded SHA256SUMS is self-consistent against the
#      downloaded tarballs, and replace $DIST_DIR contents with the
#      downloaded bytes. Downstream steps (floating alias refresh)
#      therefore upload the immutable release's exact bytes, so the
#      floating alias can never diverge from cli-internal-<sha> for
#      the same SHA.
#
# Required env:
#   TAG      immutable release tag (cli-internal-<sha>)
#   SHA      expected target commit SHA
#   GH_REPO  owner/name of the repository
#   GH_TOKEN implicit; passed through to gh
#
# Optional env:
#   DIST_DIR       local dist directory to compare and replace (default: dist)
#   GITHUB_OUTPUT  step outputs file; when set, receives release_exists=...
set -euo pipefail

: "${TAG:?TAG is required}"
: "${SHA:?SHA is required}"
: "${GH_REPO:?GH_REPO is required}"
DIST_DIR="${DIST_DIR:-dist}"

emit_output() {
  local key="$1" value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

fail() {
  # `::error::` triggers a GitHub Actions annotation; sending it to
  # stderr keeps human logs (and test harnesses) able to see the same
  # message without also parsing stdout.
  printf '::error::%s\n' "$*" >&2
  exit 1
}

check_sha256sums() {
  # Verify a downloaded SHA256SUMS is self-consistent against sibling
  # tarballs. Portable across Linux (sha256sum) and macOS (shasum) so
  # the test harness on developer machines works too; CI is Ubuntu.
  #
  # `sha256sum -c` and `shasum -a 256 -c` both skip lines that are not
  # exactly `<64 hex>  <path>` and exit 0 as long as no *checked* line
  # mismatches. A truncated or hand-forged digest would be silently
  # ignored, so pre-validate that every non-empty, non-comment line
  # already has the canonical shape before running -c.
  local dir="$1"
  local sums="${dir}/SHA256SUMS"
  local bad
  bad="$(grep -vE '^([[:space:]]*#|[[:space:]]*$|[0-9a-fA-F]{64}[[:space:]]+.+)' "$sums" || true)"
  if [ -n "$bad" ]; then
    printf '::error::SHA256SUMS has malformed line(s):\n%s\n' "$bad" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && shasum -a 256 -c SHA256SUMS)
  else
    fail "neither sha256sum nor shasum available; cannot verify SHA256SUMS"
  fi
}

release_json="$(mktemp)"
trap 'rm -f "$release_json"' EXIT

if ! gh release view "$TAG" --repo "$GH_REPO" --json targetCommitish,assets >"$release_json" 2>/dev/null; then
  emit_output release_exists false
  echo "No existing ${TAG}; will create a fresh immutable release."
  exit 0
fi

existing_target="$(jq -r '.targetCommitish' "$release_json")"
if [ "$existing_target" != "$SHA" ]; then
  fail "Existing release ${TAG} targets ${existing_target}, expected ${SHA}. Immutable releases cannot be repointed; abort."
fi

if [ ! -d "$DIST_DIR" ]; then
  fail "DIST_DIR '${DIST_DIR}' does not exist; cannot reconcile against rebuilt asset set."
fi

local_names="$(cd "$DIST_DIR" && printf '%s\n' * | LC_ALL=C sort)"
remote_names="$(jq -r '.assets[].name' "$release_json" | LC_ALL=C sort)"
if [ "$local_names" != "$remote_names" ]; then
  {
    printf '::error::Existing release %s asset manifest differs from rebuilt set; refusing to reconcile.\n' "$TAG"
    diff -u <(printf '%s\n' "$remote_names") <(printf '%s\n' "$local_names") || true
  } >&2
  exit 1
fi

# Names match; pull the immutable release's actual bytes and use them
# from here on. Content trust is the whole point of this step: name
# equality alone can pair the same filename with different bytes.
reconciled="$(mktemp -d)"
if ! gh release download "$TAG" --repo "$GH_REPO" --dir "$reconciled" >&2; then
  rm -rf "$reconciled"
  fail "gh release download failed for ${TAG}; cannot verify reconciled asset bytes."
fi

if [ ! -f "${reconciled}/SHA256SUMS" ]; then
  rm -rf "$reconciled"
  fail "Downloaded ${TAG} assets missing SHA256SUMS; refusing to reconcile."
fi
if ! check_sha256sums "$reconciled" >&2; then
  rm -rf "$reconciled"
  fail "Downloaded ${TAG} tarballs do not match their SHA256SUMS; refusing to reconcile."
fi

# Defense in depth beyond the name-set compare: fail if any local name
# is absent from the download (would only trigger on a gh partial
# download or a torn upload).
for f in "$DIST_DIR"/*; do
  name="$(basename "$f")"
  if [ ! -f "${reconciled}/${name}" ]; then
    rm -rf "$reconciled"
    fail "Reconciled download missing expected asset ${name}."
  fi
done

# Swap DIST_DIR for the immutable release's bytes so downstream steps
# (Refresh floating cli-internal-latest) upload identical content,
# never divergent rebuilds.
rm -rf "$DIST_DIR"
mv "$reconciled" "$DIST_DIR"

emit_output release_exists true
echo "Existing ${TAG} matches source SHA; reconciled ${DIST_DIR}/ from immutable release assets."
