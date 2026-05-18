#!/usr/bin/env bash
#
# Schemathesis driver for atomicmemory-core.
#
# Brings up the smoke-isolated docker compose (stub-LLM mode), waits for
# the app's /health endpoint, runs Schemathesis against openapi.yaml, then
# tears down. Propagates the Schemathesis exit code so CI fails on a
# real regression and passes when the wire shape matches the spec.
#
# Why smoke-isolated and not docker-compose.yml:
#   - Stub OPENAI_API_KEY (sk-smoke-test-dummy) so LLM-dependent endpoints
#     respond with the spec'd error envelope rather than 500 from a real
#     API call. Schemathesis only needs shape-conformance, not real
#     extraction quality.
#   - Embeddings via @huggingface/transformers (no network egress).
#   - Named volume isolated from the dev-loop docker-compose.yml so this
#     run never collides with a developer's running stack.
#
# Usage:
#   bash tests/schema/run-schemathesis.sh
#
# Outputs (in repo root, all three uploaded by CI on failure as the
# `schemathesis-diagnostics` artifact):
#   schemathesis-report.json     — Schemathesis.io tarball (despite .json suffix)
#   schemathesis-report.xml      — JUnit XML for human-readable diagnostics
#   schemathesis-cassette.yaml   — VCR cassette for failure replay
#
# Tuning: adjust the HYPOTHESIS_* / SCHEMATHESIS_CHECKS constants below.
# This script is the single authoritative source — Schemathesis 3.x's
# CLI does not consume a separate ini config, so we don't keep one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.smoke-isolated.yml"
SCHEMA_FILE="$PROJECT_DIR/openapi.yaml"
REPORT_FILE="$PROJECT_DIR/schemathesis-report.json"
JUNIT_FILE="$PROJECT_DIR/schemathesis-report.xml"
CASSETTE_FILE="$PROJECT_DIR/schemathesis-cassette.yaml"

# Match the smoke-isolated compose's default APP_PORT (3061). Override
# only if a developer's local stack already binds 3061; CI always uses
# the default.
APP_PORT="${APP_PORT:-3061}"
BASE_URL="http://localhost:${APP_PORT}"
HEALTH_URL="${BASE_URL}/health"
HEALTH_TIMEOUT_SECONDS=120
HEALTH_POLL_INTERVAL_SECONDS=2
TRANSFORMERS_WARMUP_TIMEOUT_SECONDS=900

# Schemathesis tuning. This script is the authoritative source for these
# values — Schemathesis 3.x CLI does not consume an ini config file,
# so a separate config doc would be a drift trap.
#
# - HYPOTHESIS_DEADLINE_MS: 5000ms per example. Generous so fuzz inputs
#   hitting slow paths (LLM stub timeouts, embedding warmup) don't trip
#   a deadline-failure flake. Real wire-shape issues fail well under this.
# - HYPOTHESIS_MAX_EXAMPLES: 50. Keeps the bake-window CI cycle under
#   ~3-5 minutes. Ratchet up after baseline noise is settled.
# - SCHEMATHESIS_CHECKS: only the three shape-level checks. Schemathesis'
#   default `negative_data_acceptance` flags fuzz inputs that return 4xx
#   as potential bugs — but for atomicmemory-core, 4xx on bad input is
#   correct behavior, not a regression. Suppress it by listing only the
#   three we care about.
#
# To run a single endpoint locally for debugging:
#   schemathesis run --include-path=/v1/memories/health ...
# Hypothesis deadline is disabled (`--hypothesis-deadline=None`
# below) — bake-window posture. A fuzz example that exceeds the
# per-example deadline is reported as an error even when the
# response itself was spec-conformant; for wire-shape fuzzing
# that's noise, not a regression signal. The transport-level
# `--request-timeout` (set to 30000ms) is the real bound: a route
# that genuinely hangs still fails the check.
HYPOTHESIS_MAX_EXAMPLES=50
SCHEMATHESIS_CHECKS="status_code_conformance,response_schema_conformance,content_type_conformance"

# Bearer credential Schemathesis sends on every request so it can
# probe the authenticated routes' wire shapes. MUST match the
# `CORE_API_KEY` env var passed to the `app` service in
# `docker-compose.smoke-isolated.yml`; the storage routes also
# require `X-AtomicMemory-User-Id` for owner scope, so we send
# both headers on every request. Without these, the spec's
# `bearerAuth` security requirement turns every probe into a
# 401 (or, on storage routes, a 400 `legacy_user_id_unsupported`)
# that the spec does not document, and Schemathesis reports them
# all as undocumented-status-code failures.
SMOKE_API_KEY="test-core-api-key-do-not-leak"
SMOKE_USER_ID="schemathesis-fuzz-user"

ENV_FILE="$PROJECT_DIR/.env"
ENV_FILE_CREATED_BY_SCRIPT=0

log() { echo "[schemathesis] $*"; }
fail() { echo "[schemathesis][FAIL] $*" >&2; }

remove_stub_env_file() {
  if (( ENV_FILE_CREATED_BY_SCRIPT == 1 )) && [[ -f "$ENV_FILE" ]]; then
    rm -f "$ENV_FILE"
  fi
}

cleanup() {
  log "Tearing down smoke-isolated stack"
  # --volumes wipes the named smoke_pgdata volume so re-runs start clean.
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
  remove_stub_env_file
}
trap cleanup EXIT

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd"
    exit 2
  fi
}

require_command docker
require_command curl
require_command schemathesis
require_command timeout

if [[ ! -f "$SCHEMA_FILE" ]]; then
  fail "OpenAPI schema not found at $SCHEMA_FILE"
  exit 2
fi

# The smoke-isolated compose declares `env_file: .env` for the app
# service. If the repo has no .env (CI runners check out clean), docker
# compose errors out. Create a stub so compose has something to read; the
# explicit `environment:` block in the compose file wins for any var
# the app actually consumes (OPENAI_API_KEY=sk-smoke-test-dummy etc.).
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating stub .env (compose env_file requires it; values overridden by compose)"
  echo "# Stub .env created by tests/schema/run-schemathesis.sh — see compose for real values" > "$ENV_FILE"
  ENV_FILE_CREATED_BY_SCRIPT=1
fi

log "Bringing up smoke-isolated stack (compose file: $COMPOSE_FILE)"
docker compose -f "$COMPOSE_FILE" up -d --build

log "Waiting for ${HEALTH_URL} (timeout: ${HEALTH_TIMEOUT_SECONDS}s)"
elapsed=0
until curl -sf "$HEALTH_URL" >/dev/null 2>&1; do
  if (( elapsed >= HEALTH_TIMEOUT_SECONDS )); then
    fail "App did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s"
    docker compose -f "$COMPOSE_FILE" logs --tail=200 || true
    exit 1
  fi
  sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  elapsed=$(( elapsed + HEALTH_POLL_INTERVAL_SECONDS ))
done
log "App is healthy after ${elapsed}s"

if docker compose -f "$COMPOSE_FILE" exec -T app sh -lc '[ "${EMBEDDING_PROVIDER:-}" = "transformers" ]'; then
  log "Warming transformers embedding model cache"
  timeout "$TRANSFORMERS_WARMUP_TIMEOUT_SECONDS" \
    docker compose -f "$COMPOSE_FILE" exec -T app gosu appuser node --input-type=module - <<'NODE'
const { pipeline } = await import('@huggingface/transformers');

const model = process.env.EMBEDDING_MODEL;
if (!model) {
  throw new Error('EMBEDDING_MODEL is required for transformers warmup');
}

const extractor = await pipeline('feature-extraction', model, { dtype: 'fp32' });
await extractor('schemathesis embedding warmup', {
  pooling: 'mean',
  normalize: true,
});
NODE
  log "Transformers embedding model cache is warm"
fi

log "Running Schemathesis against ${BASE_URL}"
# `--experimental=openapi-3.1` is required because openapi.yaml declares
# `openapi: 3.1.0`. Without it Schemathesis falls back to 3.0 semantics
# and rejects nullable type arrays (`type: [string, "null"]`) used in the
# spec.
#
# Reports written:
#   - $REPORT_FILE  — schemathesis.io tarball (`--report=<path>`); CI's
#     `schemathesis-report` artifact upload picks this up by name.
#   - $JUNIT_FILE   — JUnit XML for human-readable per-operation results.
#   - $CASSETTE_FILE — VCR cassette for replaying failing requests.
set +e
schemathesis run \
  --base-url="$BASE_URL" \
  --checks="$SCHEMATHESIS_CHECKS" \
  --hypothesis-deadline=None \
  --hypothesis-max-examples="$HYPOTHESIS_MAX_EXAMPLES" \
  --request-timeout=30000 \
  --experimental=openapi-3.1 \
  --schemathesis-io-telemetry=false \
  --header="Authorization: Bearer ${SMOKE_API_KEY}" \
  --header="X-AtomicMemory-User-Id: ${SMOKE_USER_ID}" \
  --exclude-path-regex='^/v1/documents$' \
  --report="$REPORT_FILE" \
  --junit-xml="$JUNIT_FILE" \
  --cassette-path="$CASSETTE_FILE" \
  "$SCHEMA_FILE"
status=$?
set -e

if (( status == 0 )); then
  log "Schemathesis run passed"
else
  fail "Schemathesis run failed with exit code $status"
  log "Report written to $REPORT_FILE (tar.gz), $JUNIT_FILE (junit), $CASSETTE_FILE (vcr)"
fi

exit "$status"
