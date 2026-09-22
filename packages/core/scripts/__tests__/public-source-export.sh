#!/usr/bin/env bash
# Verifies the public git archive omits the ECR-only hosted compatibility overlay.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if ! REPO_ROOT="$(git -C "$SCRIPT_DIR/../../../.." rev-parse --show-toplevel 2>/dev/null)"; then
  printf '%s\n' 'SKIP public source export audit outside a Git checkout'
  exit 0
fi

ARCHIVE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/am-public-source.XXXXXX")"
trap 'rm -rf "$ARCHIVE_DIR"' EXIT
ARCHIVE_PATHS="$(git -C "$REPO_ROOT" archive --format=tar --worktree-attributes HEAD | tar -tf -)"
ARCHIVE_PATHS_WITH_BOUNDARIES=$'\n'"$ARCHIVE_PATHS"$'\n'

if [[ "$ARCHIVE_PATHS_WITH_BOUNDARIES" == *$'\npackages/core/hosted/'* ]]; then
  printf '%s\n' 'private hosted overlay is present in the public source archive' >&2
  exit 1
fi

if [[ "$ARCHIVE_PATHS_WITH_BOUNDARIES" != *$'\npackages/core/Dockerfile\n'* ]]; then
  printf '%s\n' 'public source archive unexpectedly omits packages/core/Dockerfile' >&2
  exit 1
fi

for detector_path in \
  packages/core/scripts/check-public-artifacts.sh \
  packages/core/scripts/__tests__/public-artifact-leak-check.sh
do
  if [[ "$ARCHIVE_PATHS_WITH_BOUNDARIES" != *$'\n'"$detector_path"$'\n'* ]]; then
    printf 'public source archive unexpectedly omits detector fixture: %s\n' "$detector_path" >&2
    exit 1
  fi
done

git -C "$REPO_ROOT" archive --format=tar --worktree-attributes HEAD | tar -x -C "$ARCHIVE_DIR"
(
  cd "$ARCHIVE_DIR/packages/core"
  bash scripts/__tests__/run.sh
)
