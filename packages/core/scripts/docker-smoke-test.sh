#!/usr/bin/env bash
# Docker deployment smoke test.
#
# Validates the real docker-compose shape by:
#   1. Building and starting services (postgres + app)
#   2. Waiting for /health to respond
#   3. Verifying /v1/memories/health returns valid config
#   4. Posting a minimal ingest and confirming 200
#   5. Running a search and confirming results
#   6. Tearing down
#
# Catches the class of bug where the app builds and starts but fails at
# runtime due to provider misconfiguration (e.g., ollama on localhost
# inside a container, missing env vars, broken DB connection).
#
# Usage:
#   ./scripts/docker-smoke-test.sh          # full source build + test
#   SKIP_BUILD=1 ./scripts/docker-smoke-test.sh  # reuse existing compose image
#   COMPOSE_BASE_FILE=docker-compose.image.yml CORE_IMAGE=... SKIP_BUILD=1 ./scripts/docker-smoke-test.sh
#       # test a prebuilt release image
#
# Requirements: docker, docker compose, curl, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-}"
COMPOSE_BASE_FILE="${COMPOSE_BASE_FILE:-docker-compose.yml}"
APP_PORT="${APP_PORT:-}"
POSTGRES_PORT="${POSTGRES_PORT:-}"
SMOKE_ENV_FILE="$PROJECT_DIR/.env.docker-smoke-test"
ENV_FILE_CREATED_BY_SCRIPT=0
SMOKE_CORE_API_KEY="test-core-api-key-do-not-leak"
SMOKE_STORAGE_KEY_HMAC_SECRET="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
HEALTH_TIMEOUT=90
HEALTH_INTERVAL=2

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

passed=0
failed=0
total=0

log()  { echo -e "${GREEN}[smoke]${NC} $*"; }
warn() { echo -e "${YELLOW}[smoke]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }

port_in_use() {
  local port="$1"
  lsof -n -P -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local port="$1"
  while port_in_use "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

resolve_port() {
  local requested="$1"
  local fallback="$2"
  if [[ -n "$requested" ]]; then
    if port_in_use "$requested"; then
      fail "Requested port is already in use: $requested"
      exit 1
    fi
    echo "$requested"
    return
  fi
  find_free_port "$fallback"
}

assert_ok() {
  local name="$1"
  total=$((total + 1))
  if eval "$2"; then
    log "  PASS: $name"
    passed=$((passed + 1))
  else
    fail "  FAIL: $name"
    failed=$((failed + 1))
  fi
}

cleanup() {
  log "Tearing down compose stack..."
  cd "$PROJECT_DIR"
  docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans 2>/dev/null || true
  if (( ENV_FILE_CREATED_BY_SCRIPT == 1 )); then
    rm -f "$SMOKE_ENV_FILE"
  fi
}
trap cleanup EXIT

# --- Pre-flight checks ---
for cmd in docker curl jq lsof; do
  if ! command -v "$cmd" &>/dev/null; then
    fail "Required command not found: $cmd"
    exit 1
  fi
done

if ! docker info &>/dev/null; then
  fail "Docker daemon is not running"
  exit 1
fi

cd "$PROJECT_DIR"

APP_PORT="$(resolve_port "$APP_PORT" 3060)"
POSTGRES_PORT="$(resolve_port "$POSTGRES_PORT" 5444)"
if [[ -z "$COMPOSE_PROJECT" ]]; then
  COMPOSE_PROJECT="atomicmemory-smoke-test-${APP_PORT}-${POSTGRES_PORT}"
fi

if [[ -z "${ENV_FILE:-}" && ! -f "$PROJECT_DIR/.env" ]]; then
  log "Creating stub smoke env file (compose env_file requires one)"
  cat > "$SMOKE_ENV_FILE" <<EOF
CORE_API_KEY=$SMOKE_CORE_API_KEY
STORAGE_KEY_HMAC_SECRET=$SMOKE_STORAGE_KEY_HMAC_SECRET
RAW_STORAGE_DEPLOYMENT_ENV=local
EOF
  export ENV_FILE="$SMOKE_ENV_FILE"
  export CORE_API_KEY="${CORE_API_KEY:-$SMOKE_CORE_API_KEY}"
  ENV_FILE_CREATED_BY_SCRIPT=1
fi

# --- Build + Start ---
log "Starting compose stack (project=$COMPOSE_PROJECT, app_port=$APP_PORT, postgres_port=$POSTGRES_PORT)..."

# Override published ports to avoid conflicts with local dev stacks
export APP_PORT POSTGRES_PORT

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  docker compose -p "$COMPOSE_PROJECT" \
    -f "$COMPOSE_BASE_FILE" -f docker-compose.smoke.yml \
    up -d
else
  docker compose -p "$COMPOSE_PROJECT" \
    -f "$COMPOSE_BASE_FILE" -f docker-compose.smoke.yml \
    up -d --build
fi

# --- Wait for health ---
log "Waiting for app health (timeout=${HEALTH_TIMEOUT}s)..."
elapsed=0
while true; do
  if curl -sf "http://localhost:${APP_PORT}/health" >/dev/null 2>&1; then
    log "App is healthy after ${elapsed}s"
    break
  fi
  if [[ $elapsed -ge $HEALTH_TIMEOUT ]]; then
    fail "App did not become healthy within ${HEALTH_TIMEOUT}s"
    echo ""
    warn "--- app container logs ---"
    docker compose -p "$COMPOSE_PROJECT" logs app 2>&1 | tail -40
    exit 1
  fi
  sleep "$HEALTH_INTERVAL"
  elapsed=$((elapsed + HEALTH_INTERVAL))
done

BASE="http://localhost:${APP_PORT}"
CORE_API_KEY="${CORE_API_KEY:-}"
if [[ -z "$CORE_API_KEY" ]]; then
  core_env_file="${ENV_FILE:-$PROJECT_DIR/.env}"
  if [[ -f "$core_env_file" ]]; then
    CORE_API_KEY="$(grep -E '^CORE_API_KEY=' "$core_env_file" | tail -1 | cut -d= -f2-)"
  fi
fi
if [[ -z "$CORE_API_KEY" ]]; then
  fail "CORE_API_KEY is required for authenticated /v1 smoke checks"
  exit 1
fi
AUTH_HEADER=("Authorization: Bearer ${CORE_API_KEY}")

# --- Test 1: Root health ---
log "Test: root /health endpoint"
health_body=$(curl -sf "$BASE/health")
assert_ok "/health returns status=ok" \
  '[ "$(echo "$health_body" | jq -r .status)" = "ok" ]'

# --- Test 2: Memory router health with config ---
log "Test: /v1/memories/health endpoint"
mem_health=$(curl -sf -H "${AUTH_HEADER[0]}" "$BASE/v1/memories/health")
assert_ok "/v1/memories/health returns status=ok" \
  '[ "$(echo "$mem_health" | jq -r .status)" = "ok" ]'
assert_ok "/v1/memories/health includes embedding_provider" \
  '[ "$(echo "$mem_health" | jq -r .config.embedding_provider)" != "null" ]'
assert_ok "/v1/memories/health includes llm_provider" \
  '[ "$(echo "$mem_health" | jq -r .config.llm_provider)" != "null" ]'

# --- Test 3: Provider reachability ---
# Extract configured providers and verify they are reachable from inside the container
log "Test: provider reachability from inside container"
embedding_provider=$(echo "$mem_health" | jq -r .config.embedding_provider)
llm_provider=$(echo "$mem_health" | jq -r .config.llm_provider)

if [[ "$embedding_provider" == "ollama" || "$llm_provider" == "ollama" ]]; then
  # The exact bug we're catching: ollama on localhost inside Docker fails
  # The container should use host.docker.internal, not localhost
  ollama_url=$(docker compose -p "$COMPOSE_PROJECT" exec -T app \
    sh -c 'echo $OLLAMA_BASE_URL' 2>/dev/null | tr -d '\r')
  assert_ok "OLLAMA_BASE_URL does not point to localhost (would fail inside container)" \
    '! echo "$ollama_url" | grep -q "localhost"'

  # Try reaching ollama from inside the container
  ollama_reachable=$(docker compose -p "$COMPOSE_PROJECT" exec -T app \
    sh -c "curl -sf \${OLLAMA_BASE_URL}/api/tags >/dev/null 2>&1 && echo yes || echo no" \
    2>/dev/null | tr -d '\r')
  assert_ok "Ollama is reachable from inside the container" \
    '[ "$ollama_reachable" = "yes" ]'
fi

# --- Test 4: Database connectivity (via stats endpoint) ---
log "Test: database connectivity"
stats_status=$(curl -sf -o /dev/null -w '%{http_code}' \
  -H "${AUTH_HEADER[0]}" \
  -G "$BASE/v1/memories/stats" \
  --data-urlencode "user_id=smoke-test-user")
assert_ok "GET /v1/memories/stats returns 200 (DB connected)" \
  '[ "$stats_status" = "200" ]'

# --- Test 5: Quick ingest endpoint (no LLM required — embedding-only dedup) ---
log "Test: quick ingest endpoint"
ingest_response=$(curl -sf -w '\n%{http_code}' \
  -X POST "$BASE/v1/memories/ingest/quick" \
  -H "${AUTH_HEADER[0]}" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "smoke-test-user",
    "conversation": "User: I am testing the Docker deployment. The project uses PostgreSQL and Next.js.",
    "source_site": "docker-smoke-test"
  }')
ingest_status=$(echo "$ingest_response" | tail -1)
ingest_body=$(echo "$ingest_response" | sed '$d')
assert_ok "POST /v1/memories/ingest/quick returns 200" \
  '[ "$ingest_status" = "200" ]'
assert_ok "Ingest stored at least 1 memory" \
  '[ "$(echo "$ingest_body" | jq -r ".memories_stored // .memoriesStored // 0")" -ge 1 ]'

# --- Test 6: Search endpoint ---
log "Test: search endpoint"
search_response=$(curl -sf -w '\n%{http_code}' \
  -X POST "$BASE/v1/memories/search" \
  -H "${AUTH_HEADER[0]}" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "smoke-test-user",
    "query": "What database is the project using?",
    "source_site": "docker-smoke-test"
  }')
search_status=$(echo "$search_response" | tail -1)
search_body=$(echo "$search_response" | sed '$d')
assert_ok "POST /v1/memories/search returns 200" \
  '[ "$search_status" = "200" ]'
assert_ok "Search returns at least 1 result" \
  '[ "$(echo "$search_body" | jq -r .count)" -ge 1 ]'

# --- Test 7: Cleanup via reset-source ---
log "Test: reset-source cleanup"
reset_status=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/v1/memories/reset-source" \
  -H "${AUTH_HEADER[0]}" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"smoke-test-user","source_site":"docker-smoke-test"}')
assert_ok "POST /v1/memories/reset-source returns 200" \
  '[ "$reset_status" = "200" ]'

# --- Test 8: Input validation ---
log "Test: input validation"
bad_ingest_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/v1/memories/ingest" \
  -H "${AUTH_HEADER[0]}" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"x"}')
assert_ok "Missing required fields returns 400" \
  '[ "$bad_ingest_status" = "400" ]'

# --- Summary ---
echo ""
log "========================================="
if [[ $failed -eq 0 ]]; then
  log "  ALL PASSED: $passed/$total tests"
else
  fail "  FAILED: $failed/$total tests"
fi
log "========================================="

exit "$failed"
