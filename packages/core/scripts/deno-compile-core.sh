#!/usr/bin/env bash
# Experimental Deno compile for AtomicMemory Core (API-only, external Postgres).
#
# Builds a lean single executable at dist-bin/atomicmemory-core that runs
# `atomicmemory-core start` and `atomicmemory-core migrate` without Node or
# Deno installed at runtime. Postgres/pgvector must be provided separately.
#
# Size strategy: write a lockfile-pinned lean package.json, then
# `pnpm install --prod` with a hoisted linker *outside* the workspace graph
# so Deno never embeds the isolated `.pnpm` store (transformers, viem, …).
#
# Prerequisites:
#   brew install deno
#   pnpm install (from repo root or packages/core)
#
# Usage:
#   ./scripts/deno-compile-core.sh
#   OUTPUT=./dist-bin/my-core ./scripts/deno-compile-core.sh
#
# See docs/deno-compile-spike.md for findings and limitations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
OUTPUT="${OUTPUT:-$PROJECT_DIR/dist-bin/atomicmemory-core}"
STAGING="${STAGING:-$PROJECT_DIR/.deno-compile-staging}"
LEAN_HELPER="$SCRIPT_DIR/lib/write-lean-staging-package.mjs"

if ! command -v deno >/dev/null 2>&1; then
  echo "deno-compile-core: deno not found. Install with: brew install deno" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "deno-compile-core: pnpm not found (needed for lockfile-faithful install)" >&2
  exit 1
fi

write_hoisted_npmrc() {
  cat > "$1/.npmrc" <<'EOF'
node-linker=hoisted
shamefully-hoist=true
package-import-method=copy
ignore-workspace=true
EOF
}

# Deno --node-modules-dir=manual walks node_modules/.pnpm. Hoisted+copy
# leaves real packages at the root, so the store can be removed.
strip_isolated_store() {
  local nm="$1/node_modules"
  if [[ -e "$nm/@huggingface/transformers" || -e "$nm/viem" ]]; then
    echo "deno-compile-core: lean tree still contains a dropped package" >&2
    exit 1
  fi
  if [[ -L "$nm/express" && "$(readlink "$nm/express")" == *".pnpm"* ]]; then
    echo "deno-compile-core: hoisted packages still symlink into .pnpm" >&2
    exit 1
  fi
  rm -rf "$nm/.pnpm"
}

echo "[deno-compile-core] deno $(deno --version | head -1)"
echo "[deno-compile-core] building TypeScript to dist/ ..."
(cd "$PROJECT_DIR" && pnpm run build)

if [[ ! -f "$PROJECT_DIR/dist/bin.js" ]]; then
  echo "deno-compile-core: dist/bin.js missing after build" >&2
  exit 1
fi

echo "[deno-compile-core] writing lockfile-pinned lean package to $STAGING ..."
rm -rf "$STAGING"
mkdir -p "$STAGING"
LOCK_JSON="$STAGING/.pnpm-list.json"
(cd "$REPO_ROOT" && pnpm list --filter @atomicmemory/core --depth 0 --prod --json) > "$LOCK_JSON"
node "$LEAN_HELPER" write-pinned "$PROJECT_DIR/package.json" "$LOCK_JSON" "$STAGING/package.json"
write_hoisted_npmrc "$STAGING"
printf 'packages:\n  - "."\n' > "$STAGING/pnpm-workspace.yaml"
cp -R "$PROJECT_DIR/dist" "$STAGING/dist"
cp "$PROJECT_DIR/openapi.json" "$PROJECT_DIR/openapi.yaml" "$STAGING/"

echo "[deno-compile-core] installing hoisted prod tree in $STAGING ..."
(
  cd "$STAGING"
  pnpm install --prod --ignore-scripts \
    --ignore-workspace \
    --config.node-linker=hoisted \
    --config.package-import-method=copy
)
node "$LEAN_HELPER" verify "$STAGING" "$LOCK_JSON"
rm -f "$LOCK_JSON"
strip_isolated_store "$STAGING"

mkdir -p "$(dirname "$OUTPUT")"

# --node-modules-dir=manual against the hoisted lean tree. `pnpm deploy`
# left an isolated `.pnpm` store (~900 packages) that Deno never finished
# embedding inside the 45-minute CI budget.
# --allow-write is required for local_fs uploads, state, caches, and logs.
# --no-check: Deno rejects import.meta.dirname typing in openapi-spec.
echo "[deno-compile-core] compiling to $OUTPUT ..."
(
  cd "$STAGING"
  deno compile \
    --no-check \
    --node-modules-dir=manual \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-write \
    --allow-sys \
    --allow-ffi \
    --include=openapi.json \
    --include=openapi.yaml \
    --include=package.json \
    --include=dist/db/migrations \
    --output="$OUTPUT" \
    dist/bin.js
)

ls -lh "$OUTPUT"
if [[ "$(uname -s)" == "Darwin" ]]; then
  ARCH_NAME="darwin-$(uname -m)"
  PLATFORM_OUTPUT="$(dirname "$OUTPUT")/atomicmemory-core-${ARCH_NAME}"
  cp "$OUTPUT" "$PLATFORM_OUTPUT"
  ls -lh "$PLATFORM_OUTPUT"
fi
echo "[deno-compile-core] done. See docs/deno-compile-spike.md for runtime notes."
