#!/usr/bin/env bash
# Runner for Core script fixture tests (Linux-CI safe).
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
status=0

for test in \
  "$DIR"/macos-embedded-spaces.sh \
  "$DIR"/macos-embedded-preserve-data.sh \
  "$DIR"/macos-embedded-scram.sh \
  "$DIR"/macos-embedded-cleanup.sh \
  "$DIR"/macos-embedded-stop.sh \
  "$DIR"/macos-embedded-runtime-root.sh \
  "$DIR"/public-artifact-leak-check.sh \
  "$DIR"/public-source-export.sh \
  "$DIR"/package-darwin-pgvector.sh
do
  printf 'RUN %s\n' "$(basename "$test")"
  if ! bash "$test"; then
    status=1
  fi
done

printf 'RUN write-lean-staging-package.test.mjs\n'
if ! node --test "$DIR/write-lean-staging-package.test.mjs"; then
  status=1
fi

exit "$status"
