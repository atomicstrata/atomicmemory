#!/usr/bin/env bash
# Manual/macOS smoke: compiled-binary upload/read/delete against a reachable DB.
#
# Requires a compiled Core binary and DATABASE_URL. Not part of Linux CI.
#
#   export DATABASE_URL='postgresql://...'
#   export CORE_API_KEY='...'
#   export STORAGE_KEY_HMAC_SECRET='000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
#   export RAW_STORAGE_MODE=managed_blob
#   export RAW_STORAGE_PROVIDER=local_fs
#   export RAW_STORAGE_LOCAL_FS_ROOT=/tmp/am-raw
#   export RAW_STORAGE_PREFIX=local/core
#   ./scripts/macos-compiled-storage-smoke.sh ./dist-bin/atomicmemory-core

set -euo pipefail

CORE_BIN="${1:-}"
if [[ -z "$CORE_BIN" || ! -x "$CORE_BIN" ]]; then
  echo "usage: macos-compiled-storage-smoke.sh /path/to/atomicmemory-core" >&2
  exit 1
fi
if [[ -z "${DATABASE_URL:-}" || -z "${CORE_API_KEY:-}" ]]; then
  echo "DATABASE_URL and CORE_API_KEY are required" >&2
  exit 1
fi

export RAW_STORAGE_DEPLOYMENT_ENV="${RAW_STORAGE_DEPLOYMENT_ENV:-local}"
export RAW_STORAGE_MODE="${RAW_STORAGE_MODE:-managed_blob}"
export RAW_STORAGE_PROVIDER="${RAW_STORAGE_PROVIDER:-local_fs}"
export RAW_STORAGE_LOCAL_FS_ROOT="${RAW_STORAGE_LOCAL_FS_ROOT:-/tmp/am-raw-smoke}"
export RAW_STORAGE_PREFIX="${RAW_STORAGE_PREFIX:-local/core}"
export PORT="${PORT:-17359}"
export LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
mkdir -p "$RAW_STORAGE_LOCAL_FS_ROOT"

"$CORE_BIN" migrate
"$CORE_BIN" start &
core_pid=$!
cleanup() {
  kill -TERM "$core_pid" 2>/dev/null || true
  wait "$core_pid" 2>/dev/null || true
}
trap cleanup EXIT

base="http://${LISTEN_HOST}:${PORT}"
for _ in $(seq 1 40); do
  if curl -sf "$base/health" >/dev/null; then
    break
  fi
  sleep 0.1
done

doc_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
# Limits first so a missing write grant fails before PUT.
curl -sf -H "Authorization: Bearer ${CORE_API_KEY}" "$base/v1/documents/limits" >/dev/null
printf 'smoke-body' > /tmp/am-smoke-body.bin
# PUT/GET/DELETE the raw object. Route paths match the public documents API.
curl -sf -X PUT \
  -H "Authorization: Bearer ${CORE_API_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/am-smoke-body.bin \
  "$base/v1/documents/${doc_id}/raw" >/dev/null
curl -sf -H "Authorization: Bearer ${CORE_API_KEY}" \
  "$base/v1/documents/${doc_id}/raw" >/tmp/am-smoke-got.bin
cmp /tmp/am-smoke-body.bin /tmp/am-smoke-got.bin
curl -sf -X DELETE -H "Authorization: Bearer ${CORE_API_KEY}" \
  "$base/v1/documents/${doc_id}/raw" >/dev/null
echo "compiled storage smoke ok"
