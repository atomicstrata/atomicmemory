/**
 * Express application factory — wires routers onto a runtime container.
 *
 * Separates composition (done in `runtime-container.ts`) from HTTP
 * transport concerns. Tests and harnesses can create an Express app from
 * any runtime container without touching the server bootstrap.
 */

import express from 'express';
import { createAgentRouter } from '../routes/agents.js';
import { createAdminRouter } from '../routes/admin.js';
import { createDocumentRouter } from '../routes/documents.js';
import { createMemoryRouter } from '../routes/memories.js';
import { makeReflectFlushHandler } from '../routes/reflect.js';
import { runReflectForConversation } from '../services/reflect.js';
import { callAnthropicTool } from '../services/llm.js';
import { embedText } from '../services/embedding.js';
import { createStorageRouter } from '../routes/storage.js';
import { MAX_INDEX_TEXT_BYTES } from '../schemas/documents.js';
import { requireBearer } from '../middleware/require-bearer.js';
import { CORS_ALLOWED_HEADERS_VALUE } from './cors-headers.js';
import type { CoreRuntime } from './runtime-container.js';

/** Default JSON-body cap for non-document routers. */
const DEFAULT_JSON_BODY_LIMIT = '1mb';

/**
 * Build an Express application from a composed runtime container. The
 * runtime owns all deps; this module only wires HTTP concerns (CORS, body
 * parsing, routes, health).
 *
 * Body parsing is **route-scoped per router**, not global. Each
 * `app.use('/v1/<area>', ..., createXRouter())` call declares the cap
 * its router needs at the mount point — no router relies on inheriting
 * a parser from above. The documents router additionally owns its own
 * per-route parsing internally (the `/:id/index` body uses a 25 MiB cap
 * sourced from `MAX_INDEX_TEXT_BYTES`; everything else falls through to
 * the documents router's own 1 MiB JSON parser). Mounting a global
 * `express.json` on the app would silently override that ordering, so
 * we deliberately do NOT.
 */
export function createApp(runtime: CoreRuntime): ReturnType<typeof express> {
  const app = express();

  // Global CORS layer. Must short-circuit OPTIONS to 204 BEFORE any
  // mounted `requireBearer` middleware so browser preflights (which
  // never carry `Authorization`) succeed without a 401. The
  // router-level `applyCorsHeaders` in `routes/memories.ts` reads the
  // same canonical Allow-Headers list (`./cors-headers.js`) so the
  // header surface stays consistent regardless of which layer
  // produced the response.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS_VALUE);
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // `requireBearer` validates `Authorization: Bearer <CORE_API_KEY>`
  // on every SDK-facing `/v1/*` router. Built once and reused so the
  // expected-key buffer is captured a single time (timingSafeEqual
  // wants matching-length buffers; cheap but allocation-stable).
  // `/health` and `/openapi.json` stay outside this scope.
  const auth = requireBearer(runtime.config.coreApiKey);

  // Route-scoped 1 MiB JSON parsers for the non-document routers.
  app.use(
    '/v1/memories',
    auth,
    express.json({ limit: DEFAULT_JSON_BODY_LIMIT }),
    createMemoryRouter(runtime.services.memory, runtime.configRouteAdapter),
  );
  app.use(
    '/v1/agents',
    auth,
    express.json({ limit: DEFAULT_JSON_BODY_LIMIT }),
    createAgentRouter(runtime.repos.trust),
  );

  // The documents router owns its own body parsing — see
  // `createDocumentRouter` for the per-route ordering. We pass
  // `MAX_INDEX_TEXT_BYTES` and the raw-storage capability snapshot
  // through `limits` so the route layer never imports the config
  // singleton.
  const rawStorageEnabled = runtime.config.rawStorageMode === 'managed_blob';
  // Filecoin lifecycle refactor (Slice 4): when an adapter is
  // configured, source its `provider` + `capabilities` from
  // `runtime.rawContentStore`. The snapshot stays internal-camelCase;
  // `formatDocumentLimitsResponse` flips to snake_case at the wire.
  // Pointer-only deployments omit `provider`/`capabilities` so the
  // schema's optional fields validate cleanly.
  const activeStore = runtime.rawContentStore;
  const rawStorageSnapshot = rawStorageEnabled
    ? {
        enabled: true as const,
        mode: runtime.config.rawStorageMode,
        ...(activeStore
          ? {
              provider: activeStore.provider,
              capabilities: activeStore.capabilities,
            }
          : {}),
      }
    : {
        enabled: false as const,
        mode: runtime.config.rawStorageMode,
        reason: 'raw_storage_mode is pointer_only; managed-blob upload disabled',
      };
  app.use(
    '/v1/documents',
    auth,
    createDocumentRouter(runtime.services.documents, {
      rawUploadMaxBytes: runtime.config.rawUploadMaxBytes,
      limits: {
        rawUploadMaxBytes: runtime.config.rawUploadMaxBytes,
        indexMaxTextBytes: MAX_INDEX_TEXT_BYTES,
        rawStorage: rawStorageSnapshot,
      },
    }),
  );

  // Storage-sibling Step 3 added capabilities; Step 5 adds artifact
  // CRUD on the same router. The router owns its own per-route body
  // parsers (JSON for pointer-mode put + verify, `express.raw` for
  // managed-mode put), so we mount it WITHOUT a global JSON parser
  // at this prefix to avoid double-parsing managed-mode bodies.
  app.use(
    '/v1/storage',
    auth,
    createStorageRouter({
      capabilities: {
        activeStore,
        rawUploadMaxBytes: runtime.config.rawUploadMaxBytes,
      },
      service: runtime.services.storage,
      managedUploadMaxBytes: runtime.config.rawUploadMaxBytes,
    }),
  );

  if (runtime.config.coreAdminApiKey && runtime.config.coreTestScopeAllowPattern) {
    app.use(
      '/v1/admin',
      requireBearer(runtime.config.coreAdminApiKey),
      express.json({ limit: DEFAULT_JSON_BODY_LIMIT }),
      createAdminRouter({
        memory: runtime.repos.memory,
        testScopeAllowPattern: runtime.config.coreTestScopeAllowPattern,
      }),
    );
  }

  // Reflect flush: synchronous queue drain for benchmark / eval harnesses.
  // Wired regardless of reflectEnabled so the route always exists; the
  // handler returns 503 when reflect is disabled.
  const { reflectionJobs, reflections, entityCards } = runtime.stores;
  const reflectEnabled = runtime.config.reflectEnabled;
  const entityCardDeps = entityCards && runtime.config.entityCardEnabled
    ? {
        enabled: true,
        repo: entityCards,
        synth: {
          llmCallTool: (system: string, user: string, schema: Parameters<typeof callAnthropicTool>[3]) =>
            callAnthropicTool<{ card_text: string }>(
              runtime.config.reflectModel, system, user, schema,
            ),
          minObservations: runtime.config.entityCardMinObservations,
          maxEntities: runtime.config.entityCardMaxPerSession,
        },
        maxCardsPerSession: runtime.config.entityCardMaxPerSession,
      }
    : undefined;
  const reflectFlushDeps = {
    jobs: reflectionJobs ?? {
      fetchPending: async () => [],
      markInProgress: async () => undefined,
      markCompleted: async () => undefined,
      markFailed: async () => undefined,
    },
    runReflect: (userId: string, conversationId: string) =>
      runReflectForConversation(
        {
          fetchMemories: (u, c) => runtime.repos.memory.findByConversation(u, c),
          llmCallTool: (system, user, schema) =>
            callAnthropicTool(
              runtime.config.reflectModel,
              system,
              user,
              schema as Parameters<typeof callAnthropicTool>[3],
            ),
          embed: (text) => embedText(text),
          reflections: reflections ?? { insertMany: async () => undefined },
          maxObservations: runtime.config.reflectMaxObservations,
          entityCards: entityCardDeps,
        },
        userId,
        conversationId,
      ),
  };
  app.post('/v1/reflect/flush', makeReflectFlushHandler(reflectFlushDeps, reflectEnabled));

  // `/health` is intentionally unversioned — it is an infrastructure
  // liveness probe (load balancers, Docker, Railway), not part of the
  // versioned application API. Versioned endpoints live under `/v1/*`.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
