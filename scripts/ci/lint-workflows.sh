#!/usr/bin/env bash
# Lint every GitHub Actions workflow with actionlint, including the shell inside
# each `run:` block.
#
# Why this exists: on 2026-09-01 a stray `fi` landed in mirror-cli-r2.yml's first
# step (ATO-1934). That step is a bash syntax error — it cannot execute a single
# line — and it sat on `dev` undetected, because the repo's four workflow
# checkers (test:mirror-cli-r2, test:release-cli-version, security-compliance,
# reporter-grades-every-lane) all match workflow *text* and none of them parse
# the embedded shell. actionlint does, via shellcheck, and reports it as an
# error. It would have failed the commit that introduced it.
#
# Pinned by version and verified by checksum rather than installed from a
# floating action: this runs on every push, and an unpinned tool in CI is a
# supply-chain edge we control cheaply.
#
# Usage:
#   bash scripts/ci/lint-workflows.sh          # download the pinned binary
#   AM_ACTIONLINT=$(command -v actionlint) \
#     bash scripts/ci/lint-workflows.sh        # use an already-installed one
set -euo pipefail

ACTIONLINT_VERSION="1.7.12"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# An operator-supplied binary skips the download, but never the version check —
# a different actionlint reports a different set of findings, and a lane that
# silently grades against an unknown version is not a gate.
if [[ -n "${AM_ACTIONLINT:-}" ]]; then
  installed="$("$AM_ACTIONLINT" --version | head -n1)"
  if [[ "$installed" != "$ACTIONLINT_VERSION" ]]; then
    echo "AM_ACTIONLINT is actionlint ${installed}, expected ${ACTIONLINT_VERSION}" >&2
    exit 1
  fi
  exec "$AM_ACTIONLINT" -color
fi

# Platform and its checksum resolved together, in a `case` rather than an
# associative array: `declare -A` needs bash 4 and macOS ships 3.2, where it
# fails as an unbound variable instead of a syntax error.
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    platform="linux_amd64"
    expected="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
    ;;
  Darwin/arm64)
    platform="darwin_arm64"
    expected="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
    ;;
  *)
    echo "no pinned actionlint for $(uname -s)/$(uname -m)." >&2
    echo "Install it yourself and re-run with AM_ACTIONLINT=\$(command -v actionlint)." >&2
    exit 1
    ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

tarball="actionlint_${ACTIONLINT_VERSION}_${platform}.tar.gz"
url="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${tarball}"
curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 --retry 3 "$url" -o "$work/$tarball"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$tarball" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/$tarball" | cut -d' ' -f1)"
fi
if [[ "$actual" != "$expected" ]]; then
  echo "checksum mismatch for ${tarball}" >&2
  echo "  expected ${expected}" >&2
  echo "  actual   ${actual}" >&2
  exit 1
fi

tar -C "$work" -xzf "$work/$tarball" actionlint
exec "$work/actionlint" -color
