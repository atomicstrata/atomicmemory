FROM node:22-slim AS node

FROM pgvector/pgvector:pg17

WORKDIR /app

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY package.json package-lock.json ./

# --legacy-peer-deps: openai@4.x still declares a peerOptional on zod@^3,
# while the rest of the tree has moved to zod@^4.
# --ignore-scripts: image builds do not need local Git hooks.
RUN HUSKY=0 npm ci --omit=dev --legacy-peer-deps --ignore-scripts \
  && npm cache clean --force

COPY src/ ./src/
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY tsconfig.json ./

RUN useradd --create-home appuser \
  && mkdir -p /var/lib/atomicmemory/postgres /var/run/atomicmemory-postgres \
  && chown -R appuser:appuser /app \
  && chown -R postgres:postgres /var/lib/atomicmemory/postgres /var/run/atomicmemory-postgres \
  && chmod +x /app/scripts/docker-entrypoint.sh

ENV PATH="/usr/lib/postgresql/17/bin:${PATH}"
ENV NODE_ENV=production
ENV PORT=3050
ENV DATABASE_URL=embedded
ENV EMBEDDING_DIMENSIONS=1536
ENV RAW_STORAGE_DEPLOYMENT_ENV=local
ENV EMBEDDED_POSTGRES_DATA_DIR=/var/lib/atomicmemory/postgres
ENV EMBEDDED_POSTGRES_RUN_DIR=/var/run/atomicmemory-postgres
ENV EMBEDDED_POSTGRES_PORT=5432
ENV EMBEDDED_POSTGRES_USER=atomicmemory
ENV EMBEDDED_POSTGRES_DB=atomicmemory

EXPOSE 3050

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
