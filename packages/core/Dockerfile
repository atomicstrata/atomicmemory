# Build context: workspace root (see packages/core/docker-compose.yml `build:`).
# Canonical Turborepo + pnpm Docker pattern:
#   1) `turbo prune --docker` produces an `out/` tree with only @atomicmemory/core
#      and its workspace dependencies (manifests + lockfile in `out/json`,
#      source in `out/full`).
#   2) Installer stage installs prod deps from the pruned lockfile — this layer
#      is cached as long as manifests and lockfile don't change.
#   3) Builder stage runs `pnpm deploy --prod` to produce a self-contained
#      `/deploy` tree (flat node_modules + package.json).
#   4) Runtime image is pgvector + Node + the deployed package + TypeScript
#      source for tsx.

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
# Stage 2 — installer: production deps only
# ---------------------------------------------------------------------------
FROM node:22-slim AS installer
ENV CI=1 HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --filter @atomicmemory/core --prod --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 3 — builder: add full source and deploy a flat tree to /deploy
# ---------------------------------------------------------------------------
FROM installer AS builder
COPY --from=pruner /repo/out/full/ ./
RUN pnpm deploy --filter @atomicmemory/core --prod /deploy

# ---------------------------------------------------------------------------
# Stage 4 — runtime: pgvector + Node + deployed package
# ---------------------------------------------------------------------------
FROM pgvector/pgvector:pg17

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

# Source / scripts / tsconfig — runtime uses tsx against src/, not prebuilt dist/.
COPY packages/core/src ./src
COPY packages/core/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY packages/core/tsconfig.json ./tsconfig.json

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

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
