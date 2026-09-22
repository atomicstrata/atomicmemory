#!/usr/bin/env bash
# Regression tests for the public package and final-image leak gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$SCRIPT_DIR/../check-public-artifacts.sh"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/am-public-artifacts.XXXXXX")"
PATTERN_FILE="$WORK_DIR/private-signatures.txt"
trap 'rm -rf "$WORK_DIR"' EXIT

assert_fails() {
  if "$@"; then
    printf 'expected command to fail: %q\n' "$*" >&2
    exit 1
  fi
}

make_archive() {
  local directory="$1"
  local output="$2"
  tar -C "$directory" -czf "$output" .
}

make_image_archive() {
  local directory="$1"
  local output="$2"
  tar -C "$directory" -cf "$output" .
}

make_fake_docker() {
  mkdir -p "$WORK_DIR/bin"
  cat > "$WORK_DIR/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  create) printf '%s\n' fixture-container ;;
  export) cat "$FAKE_IMAGE_TAR" ;;
  rm) ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "$WORK_DIR/bin/docker"
}

mkdir -p \
  "$WORK_DIR/package" \
  "$WORK_DIR/image/app/dist" \
  "$WORK_DIR/image/app/scripts" \
  "$WORK_DIR/image/app/node_modules/@aws-sdk/client-s3"
printf 'safe package\n' > "$WORK_DIR/package/README.md"
printf 'safe image\n' > "$WORK_DIR/image/app/dist/server.js"
printf 'safe entrypoint\n' > "$WORK_DIR/image/app/scripts/docker-entrypoint.sh"
printf '{}\n' > "$WORK_DIR/image/app/openapi.json"
printf 'openapi: 3.1.0\n' > "$WORK_DIR/image/app/openapi.yaml"
printf '{"name":"@atomicmemory/core"}\n' > "$WORK_DIR/image/app/package.json"
# This is public documentation from a pinned production dependency. The gate
# must inspect our shipped application files without treating this generic term
# as enterprise-only content.
printf 'Configure a customer-cmk for S3 encryption.\n' \
  > "$WORK_DIR/image/app/node_modules/@aws-sdk/client-s3/README.md"
make_archive "$WORK_DIR/package" "$WORK_DIR/package.tgz"
make_image_archive "$WORK_DIR/image" "$WORK_DIR/image.tar"
make_fake_docker
printf '%s\n' \
  'private-fixture-marker' \
  'private-test-endpoint.invalid' \
  > "$PATTERN_FILE"

PATH="$WORK_DIR/bin:$PATH" FAKE_IMAGE_TAR="$WORK_DIR/image.tar" \
  "$CHECKER" "$WORK_DIR/package.tgz" fixture:image "$PATTERN_FILE"

printf 'private-fixture-marker\n' > "$WORK_DIR/package/README.md"
make_archive "$WORK_DIR/package" "$WORK_DIR/package.tgz"
assert_fails env PATH="$WORK_DIR/bin:$PATH" FAKE_IMAGE_TAR="$WORK_DIR/image.tar" \
  "$CHECKER" "$WORK_DIR/package.tgz" fixture:image "$PATTERN_FILE"

printf 'safe package\n' > "$WORK_DIR/package/README.md"
printf 'private-fixture-marker\n' > "$WORK_DIR/image/app/dist/server.js"
make_archive "$WORK_DIR/package" "$WORK_DIR/package.tgz"
make_image_archive "$WORK_DIR/image" "$WORK_DIR/image.tar"
assert_fails env PATH="$WORK_DIR/bin:$PATH" FAKE_IMAGE_TAR="$WORK_DIR/image.tar" \
  "$CHECKER" "$WORK_DIR/package.tgz" fixture:image "$PATTERN_FILE"

printf 'https://private-test-endpoint.invalid\n' > "$WORK_DIR/image/app/dist/server.js"
make_archive "$WORK_DIR/package" "$WORK_DIR/package.tgz"
make_image_archive "$WORK_DIR/image" "$WORK_DIR/image.tar"
assert_fails env PATH="$WORK_DIR/bin:$PATH" FAKE_IMAGE_TAR="$WORK_DIR/image.tar" \
  "$CHECKER" "$WORK_DIR/package.tgz" fixture:image "$PATTERN_FILE"
