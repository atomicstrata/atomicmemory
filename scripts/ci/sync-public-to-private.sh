#!/usr/bin/env bash
# Merge a public snapshot into private main, preserving private-only history/files.
set -euo pipefail

remote="${1:?private remote is required}"
public_commit="${2:?public commit is required}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Public-to-private sync requires a clean checkout.' >&2
  exit 1
fi

git rev-parse --verify "${public_commit}^{commit}" >/dev/null
git fetch --no-tags "$remote" refs/heads/main
git switch --detach FETCH_HEAD

# A conflict must be resolved internally, never by replacing the private tree.
if ! git merge --no-edit "$public_commit"; then
  git merge --abort
  echo 'Public-to-private merge conflicted; resolve it in the private repository.' >&2
  exit 1
fi

# Ordinary push rejects a concurrent private update. Never force or auto-retry.
git push "$remote" HEAD:refs/heads/main
