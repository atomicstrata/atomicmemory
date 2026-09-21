#!/usr/bin/env bash
# Fails a release when private hosted identifiers enter public Core artifacts.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  printf 'usage: %s <package-tarball> <image-reference> <forbidden-pattern-file>\n' "$0" >&2
  exit 64
fi

PACKAGE_TARBALL="$1"
IMAGE_REFERENCE="$2"
FORBIDDEN_PATTERN_FILE="$3"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/am-public-artifacts.XXXXXX")"
PACKAGE_DIR="$WORK_DIR/package"
IMAGE_DIR="$WORK_DIR/image"
CONTAINER_ID=""

if [ ! -s "$FORBIDDEN_PATTERN_FILE" ]; then
  printf 'forbidden pattern file is missing or empty: %s\n' "$FORBIDDEN_PATTERN_FILE" >&2
  exit 64
fi

cleanup() {
  if [ -n "$CONTAINER_ID" ]; then
    docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

scan_artifact() {
  local label="$1"
  shift
  local artifact_path
  local scan_status
  local matches
  for artifact_path in "$@"; do
    if [ ! -e "$artifact_path" ]; then
      printf 'expected artifact path missing from %s: %s\n' "$label" "$artifact_path" >&2
      exit 1
    fi
  done
  if matches="$(rg --files-with-matches --hidden --no-ignore -a -i \
    -f "$FORBIDDEN_PATTERN_FILE" "$@")"; then
    :
  else
    scan_status=$?
    if [ "$scan_status" -ne 1 ]; then
      printf 'unable to scan %s with forbidden pattern file: %s\n' \
        "$label" "$FORBIDDEN_PATTERN_FILE" >&2
      exit "$scan_status"
    fi
    matches=""
  fi
  if [ -n "$matches" ]; then
    printf 'private identifier found in %s:\n%s\n' "$label" "$matches" >&2
    exit 1
  fi
}

mkdir -p "$PACKAGE_DIR" "$IMAGE_DIR"
tar -xzf "$PACKAGE_TARBALL" -C "$PACKAGE_DIR"
scan_artifact 'package tarball' "$PACKAGE_DIR"

CONTAINER_ID="$(docker create "$IMAGE_REFERENCE")"
docker export "$CONTAINER_ID" | tar -x -C "$IMAGE_DIR"
scan_artifact 'final image application inputs' \
  "$IMAGE_DIR/app/dist" \
  "$IMAGE_DIR/app/scripts" \
  "$IMAGE_DIR/app/openapi.json" \
  "$IMAGE_DIR/app/openapi.yaml" \
  "$IMAGE_DIR/app/package.json"

printf 'public artifact leak check passed\n'
