# Build context: workspace root.
# Canonical Turborepo + pnpm Docker pattern for @atomicmemory/mcp-server:
#   1) `turbo prune --docker` shrinks the monorepo to mcp-server + workspace deps.
#   2) Builder installs the pruned workspace from the frozen lockfile, compiles
#      SDK then mcp-server, and `pnpm deploy --prod`s each one so production
#      dependencies come from pnpm-lock.yaml (never a fresh npm resolution).
#      mcp-server links the workspace SDK, so its deploy holds a symlink back
#      into the monorepo; that link is replaced with the SDK's own deploy.
#   3) Runtime copies the self-contained tree only - no source/tests, no API keys.
#
# Base images are pinned by multi-arch index digest; bump the digest to take
# node:22-slim security updates.
#
# Locked hosted contract (HOSTED.md): port 3100, GET /healthz, CMD --http.
# Do NOT bake ATOMICMEMORY_API_KEY. Task def must set ATOMICMEMORY_API_URL.

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS pruner
ENV CI=1 HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.9.14 prune @atomicmemory/mcp-server --docker \
  && cp tsconfig.base.json out/full/tsconfig.base.json

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS builder
ENV CI=1 HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --filter "@atomicmemory/mcp-server..." --ignore-scripts
COPY --from=pruner /repo/out/full/ ./
# SDK is a workspace dependency; build it before mcp-server. `pnpm deploy`
# installs each package's prod dependencies from the workspace lockfile (the
# frozen install above guarantees it matches every manifest). Workspace
# packages are not hoisted so no link points back into /repo, and the final
# check fails the build if any symlink would dangle in the runtime image.
RUN pnpm --filter @atomicmemory/sdk build \
  && pnpm --filter @atomicmemory/mcp-server build \
  && pnpm --filter @atomicmemory/mcp-server deploy --prod --ignore-scripts \
       --config.hoist-workspace-packages=false /deploy/app \
  && pnpm --filter @atomicmemory/sdk deploy --prod --ignore-scripts \
       --config.hoist-workspace-packages=false /deploy/sdk \
  && rm /deploy/app/node_modules/@atomicmemory/sdk \
  && mv /deploy/sdk /deploy/app/node_modules/@atomicmemory/sdk \
  && escaped="$(find /deploy/app -type l -exec sh -c \
       'case "$(readlink -f "$1")" in /deploy/app/*) ;; *) echo "$1" ;; esac' _ {} \;)" \
  && if [ -n "${escaped}" ]; then \
       echo "symlinks escape the deploy tree:" >&2; echo "${escaped}" >&2; exit 1; \
     fi

FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 appuser

# The deploy tree is mcp-server's published files (dist, package.json) plus
# its lockfile-pinned node_modules, so CMD matches HOSTED.md
# (`node dist/bin.js --http`). Root-owned and read-only to appuser.
COPY --from=builder /deploy/app /app

USER appuser

ENV NODE_ENV=production
ENV ATOMICMEMORY_MCP_TRANSPORT=http
ENV ATOMICMEMORY_MCP_HOST=0.0.0.0
ENV ATOMICMEMORY_MCP_PORT=3100

EXPOSE 3100

# Health: GET /healthz → 200 {"ok":true} (also /health). Auth is per-request Bearer.
CMD ["node", "dist/bin.js", "--http"]
