#!/usr/bin/env bash
# Print the persisted local CORE_API_KEY from a running Core container.
# Reads the state volume file written by docker-entrypoint.sh (generated or
# explicit override). Usage: ./scripts/show-local-core-key.sh [container_name]
set -euo pipefail
CONTAINER="${1:-atomic-memory}"
docker exec "$CONTAINER" cat /var/lib/atomicmemory/state/core-api-key
