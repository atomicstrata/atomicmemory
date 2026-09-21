# Build context: workspace root (see packages/core/docker-compose.yml `build:`).
# Canonical Turborepo + pnpm Docker pattern:
#   1) `turbo prune --docker` produces an `out/` tree with only @atomicmemory/core
#      and its workspace dependencies (manifests + lockfile in `out/json`,
#      source in `out/full`).
#   2) Builder installs the pruned workspace, compiles Core, then produces a
#      self-contained production dependency tree in `/deploy`.
#   3) Runtime copies only compiled production files, never the source/tests.

FROM node:22-slim AS node-base

# ---------------------------------------------------------------------------
# Stage 1 — pruner: shrink workspace to @atomicmemory/core's scope
# ---------------------------------------------------------------------------
FROM node:22-slim AS pruner
ENV CI=1 HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.9.14 prune @atomicmemory/core --docker

# ---------------------------------------------------------------------------
# Stage 2 — builder: compile Core and deploy production dependencies
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder
ENV CI=1 HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --filter @atomicmemory/core --ignore-scripts
COPY --from=pruner /repo/out/full/ ./
RUN pnpm --filter @atomicmemory/core build \
  && pnpm deploy --filter @atomicmemory/core --prod /deploy

# ---------------------------------------------------------------------------
# Stage 3 — runtime base: pgvector + Node + compiled Core
# ---------------------------------------------------------------------------
FROM pgvector/pgvector:pg17 AS runtime-base

WORKDIR /app

COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Production node_modules + package.json from pnpm deploy.
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./package.json

# Compile output excludes test files by tsconfig.build.json.
COPY --from=builder /repo/packages/core/dist ./dist
COPY packages/core/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
# The committed OpenAPI spec — loaded eagerly at startup by src/app/openapi-spec.ts
# (`../../openapi.json` from dist/app -> /app/openapi.json) and served at GET /openapi.json.
# Without this the container crashes on boot with ENOENT.
COPY packages/core/openapi.json ./openapi.json
COPY packages/core/openapi.yaml ./openapi.yaml

RUN useradd --create-home appuser \
  && mkdir -p /var/lib/atomicmemory/postgres /var/run/atomicmemory-postgres \
  && chown -R appuser:appuser /app \
  && chown -R postgres:postgres /var/lib/atomicmemory/postgres /var/run/atomicmemory-postgres \
  && chmod +x /app/scripts/docker-entrypoint.sh

ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"
ENV NODE_ENV=production
ENV PORT=17350
ENV DATABASE_URL=embedded
ENV EMBEDDING_DIMENSIONS=1536
ENV RAW_STORAGE_DEPLOYMENT_ENV=local
ENV EMBEDDED_POSTGRES_DATA_DIR=/var/lib/atomicmemory/postgres
ENV EMBEDDED_POSTGRES_RUN_DIR=/var/run/atomicmemory-postgres
ENV EMBEDDED_POSTGRES_PORT=5432
ENV EMBEDDED_POSTGRES_USER=atomicmemory
ENV EMBEDDED_POSTGRES_DB=atomicmemory

EXPOSE 17350

# ECR-only stage: retain private hosted compatibility outside public npm/GHCR.
FROM runtime-base AS hosted-runtime
COPY packages/core/hosted/migration-history-overlay.mjs /app/private/migration-history-overlay.mjs
COPY packages/core/hosted/docker-entrypoint.sh /app/private/docker-entrypoint.sh
RUN chmod +x /app/private/docker-entrypoint.sh
ENTRYPOINT ["/app/private/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]

# Public default stage: no private overlay, source tree, or test tree.
FROM runtime-base AS public-runtime
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
