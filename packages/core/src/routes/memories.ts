/**
 * Memory API routes for ingest, search, listing, stats, config, and deletion.
 * Keeps the existing `/v1/memories/ingest` and `/v1/memories/search` contract stable.
 *
 * Request validation for every route is delegated to the Zod-based
 * validators in `src/middleware/validate.ts` using schemas authored in
 * `src/schemas/memories.ts`. `validateBody` / `validateQuery` /
 * `validateParams` replace the hand-written `parseIngestBody` /
 * `parseSearchBody` / `requireBodyString` helpers this file previously
 * exported. The 400 response envelope `{ error: string }` is
 * preserved byte-for-byte by `formatZodIssues`.
 */

import { Router, type Request, type Response } from 'express';
import { config, updateRuntimeConfig, type RuntimeConfig } from '../config.js';
import {
  readRuntimeConfigRouteSnapshot as projectRuntimeConfigRouteSnapshot,
  type RuntimeConfigRouteSnapshot,
} from '../app/runtime-config-route-snapshot.js';
import { MemoryService, type RetrievalResult } from '../services/memory-service.js';
import type { MemoryScope, MemoryServiceDeps, RetrievalObservability } from '../services/memory-service-types.js';
import {
  applyConfigOverride,
  hashEffectiveConfig,
  summarizeOverrideKeys,
} from '../services/retrieval-config-overlay.js';
import {
  formatIngestResponse,
  formatScope,
  formatStatsResponse,
  formatConsolidateResponse,
  formatConsolidateExecuteResponse,
  formatDecayResponse,
  formatCapResponse,
  formatLessonStatsResponse,
  formatReconciliationResponse,
  formatResetSourceResponse,
  formatMutationSummaryResponse,
  formatAuditTrailEntry,
  formatObservability,
} from './memory-response-formatters.js';
import type { AgentScope, WorkspaceContext } from '../db/repository-types.js';
import { handleRouteError } from './route-errors.js';
import { validateBody, validateQuery, validateParams } from '../middleware/validate.js';
import { CORS_ALLOWED_HEADERS_VALUE } from '../app/cors-headers.js';
import { validateResponse } from '../middleware/validate-response.js';
import { MEMORY_RESPONSE_SCHEMAS } from './response-schema-map.js';
import {
  IngestBodySchema,
  type IngestBody,
  SearchBodySchema,
  type SearchBody,
  ExpandBodySchema,
  VerifyBodySchema,
  ConsolidateBodySchema,
  DecayBodySchema,
  ReconcileBodySchema,
  ResetSourceBodySchema,
  LessonReportBodySchema,
  UserIdQuerySchema,
  EventChainsQuerySchema,
  FirstMentionsExtractBodySchema,
  UserIdLimitQuerySchema,
  ListQuerySchema,
  MemoryByIdQuerySchema,
  UuidIdParamSchema,
  FreeIdParamSchema,
  ConfigBodySchema,
} from '../schemas/memories.js';
import { verifyAnswer } from '../services/answer-verifier.js';

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3050,http://localhost:3081')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

interface RuntimeConfigRouteAdapter {
  base(): RuntimeConfig;
  current(): RuntimeConfigRouteSnapshot;
  update(updates: RuntimeConfigRouteUpdates): string[];
}

interface RuntimeConfigRouteUpdates {
  similarityThreshold?: number;
  audnCandidateThreshold?: number;
  clarificationConflictThreshold?: number;
  maxSearchResults?: number;
}

interface IngestRequestContext {
  body: IngestBody;
  effectiveConfig: MemoryServiceDeps['config'] | undefined;
}

interface SearchRequestContext {
  body: SearchBody;
  effectiveConfig: MemoryServiceDeps['config'] | undefined;
  scope: MemoryScope;
  requestLimit: number | undefined;
}

interface MemoryByIdRouteQuery {
  userId: string;
  workspaceId: string | undefined;
  agentId: string | undefined;
}

const STARTUP_ONLY_CONFIG_FIELDS = [
  'embedding_provider',
  'embedding_model',
  'voyage_api_key',
  'voyage_document_model',
  'voyage_query_model',
  'llm_provider',
  'llm_model',
] as const;

const defaultRuntimeConfigRouteAdapter: RuntimeConfigRouteAdapter = {
  base() {
    return config;
  },
  current() {
    return readRuntimeConfigRouteSnapshot();
  },
  update(updates) {
    return updateRuntimeConfig(updates);
  },
};

export function createMemoryRouter(
  service: MemoryService,
  configRouteAdapter: RuntimeConfigRouteAdapter = defaultRuntimeConfigRouteAdapter,
): Router {
  const router = Router();
  registerCors(router);
  // Dev/test-mode response validator: no-op in production, throws loudly
  // if any 2xx body violates the schema declared in responses.ts.
  router.use(validateResponse(MEMORY_RESPONSE_SCHEMAS));
  registerIngestRoute(router, service, configRouteAdapter);
  registerQuickIngestRoute(router, service, configRouteAdapter);
  registerSearchRoute(router, service, configRouteAdapter);
  registerFastSearchRoute(router, service, configRouteAdapter);
  registerVerifyRoute(router);
  registerExpandRoute(router, service);
  registerListRoute(router, service);
  registerStatsRoute(router, service);
  registerHealthRoute(router, configRouteAdapter);
  registerConfigRoute(router, configRouteAdapter);
  registerEventChainsRoute(router, service);
  registerFirstMentionsExtractRoute(router, service);
  registerConsolidateRoute(router, service);
  registerDecayRoute(router, service);
  registerCapRoute(router, service);
  registerAuditSummaryRoute(router, service);
  registerAuditRecentRoute(router, service);
  registerAuditTrailRoute(router, service);
  registerLessonRoutes(router, service);
  registerReconcileRoute(router, service);
  registerResetSourceRoute(router, service);
  registerGetRoute(router, service);
  registerDeleteRoute(router, service);
  return router;
}

function registerCors(router: Router): void {
  router.use((req: Request, res: Response, next) => {
    applyCorsHeaders(req, res);
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
}

function registerIngestRoute(
  router: Router,
  service: MemoryService,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): void {
  router.post('/ingest', validateBody(IngestBodySchema), async (req: Request, res: Response) => {
    try {
      await handleIngestRequest(service, req, res, configRouteAdapter, 'full');
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/ingest', err);
    }
  });
}

function registerQuickIngestRoute(
  router: Router,
  service: MemoryService,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): void {
  router.post('/ingest/quick', validateBody(IngestBodySchema), async (req: Request, res: Response) => {
    try {
      await handleIngestRequest(service, req, res, configRouteAdapter, 'quick');
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/ingest/quick', err);
    }
  });
}

async function handleIngestRequest(
  service: MemoryService,
  req: Request,
  res: Response,
  configRouteAdapter: RuntimeConfigRouteAdapter,
  mode: 'full' | 'quick',
): Promise<void> {
  const { body, effectiveConfig } = readIngestRequest(req, res, configRouteAdapter);
  // Caller-supplied `metadata` is only honored on the verbatim branch
  // (mode === 'quick' && skip_extraction === true && no workspace).
  // Reject loudly elsewhere — silent drops would violate the
  // "no silent error catching" rule. Direct res.status(400).json(...)
  // because handleRouteError emits 500-only.
  if (
    body.metadata &&
    !(mode === 'quick' && body.skipExtraction && !body.workspace)
  ) {
    res.status(400).json({
      error:
        'metadata is only supported on /v1/memories/ingest/quick with skip_extraction=true and no workspace context',
    });
    return;
  }
  const result = await runIngest(service, body, effectiveConfig, mode);
  res.json(formatIngestResponse(result));
}

async function runIngest(
  service: MemoryService,
  body: IngestBody,
  effectiveConfig: MemoryServiceDeps['config'] | undefined,
  mode: 'full' | 'quick',
) {
  if (body.workspace) {
    return service.workspaceIngest({
      userId: body.userId,
      conversationText: body.conversation,
      sourceSite: body.sourceSite,
      sourceUrl: body.sourceUrl,
      workspace: body.workspace,
      effectiveConfig,
      sessionId: body.sessionId,
    });
  }
  if (mode === 'full') {
    return service.ingest({
      userId: body.userId,
      conversationText: body.conversation,
      sourceSite: body.sourceSite,
      sourceUrl: body.sourceUrl,
      effectiveConfig,
      sessionId: body.sessionId,
    });
  }
  if (body.skipExtraction) {
    return service.storeVerbatim({
      userId: body.userId,
      content: body.conversation,
      sourceSite: body.sourceSite,
      sourceUrl: body.sourceUrl,
      metadata: body.metadata,
      effectiveConfig,
      sessionId: body.sessionId,
    });
  }
  return service.quickIngest({
    userId: body.userId,
    conversationText: body.conversation,
    sourceSite: body.sourceSite,
    sourceUrl: body.sourceUrl,
    effectiveConfig,
    sessionId: body.sessionId,
  });
}

/**
 * Resolve scope + clamped limit using the *effective* maxSearchResults — i.e.
 * the post-override value when a `config_override` was carried, or the startup
 * snapshot otherwise. Clamping against the startup snapshot when an override
 * is present would silently pin requests to the old cap even though
 * `X-Atomicmem-Effective-Config-Hash` advertises the new one.
 */
function resolveSearchPreamble(body: SearchBody, maxSearchResults: number) {
  const scope = toMemoryScope(body.userId, body.workspace, body.agentScope as AgentScope | undefined);
  const requestLimit = body.limit === undefined
    ? undefined
    : resolveEffectiveSearchLimit(body.limit, maxSearchResults);
  return { scope, requestLimit };
}

function readIngestRequest(
  req: Request,
  res: Response,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): IngestRequestContext {
  const body = req.body as IngestBody;
  return {
    body,
    effectiveConfig: applyRequestConfigOverride(res, configRouteAdapter.base(), body.configOverride),
  };
}

function readSearchRequest(
  req: Request,
  res: Response,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): SearchRequestContext {
  const body = req.body as SearchBody;
  const effectiveConfig = applyRequestConfigOverride(res, configRouteAdapter.base(), body.configOverride);
  const maxSearchResults = effectiveConfig?.maxSearchResults ?? configRouteAdapter.current().maxSearchResults;
  const { scope, requestLimit } = resolveSearchPreamble(body, maxSearchResults);
  return { body, effectiveConfig, scope, requestLimit };
}

function registerSearchRoute(
  router: Router,
  service: MemoryService,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): void {
  router.post('/search', validateBody(SearchBodySchema), async (req: Request, res: Response) => {
    try {
      const { body, effectiveConfig, scope, requestLimit } = readSearchRequest(req, res, configRouteAdapter);
      const retrievalOptions: {
        retrievalMode?: SearchBody['retrievalMode'];
        tokenBudget?: SearchBody['tokenBudget'];
        relevanceThreshold?: SearchBody['relevanceThreshold'];
        skipRepairLoop?: boolean;
      } = {
        retrievalMode: body.retrievalMode,
        tokenBudget: body.tokenBudget,
        relevanceThreshold: body.relevanceThreshold,
        ...(body.skipRepair ? { skipRepairLoop: true } : {}),
      };
      const result = await service.scopedSearch(scope, body.query, {
        sourceSite: body.sourceSite,
        limit: requestLimit,
        asOf: body.asOf,
        namespaceScope: body.namespaceScope,
        sessionId: body.sessionId,
        retrievalOptions,
        effectiveConfig,
      });
      res.json(formatSearchResponse(result, scope));
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/search', err);
    }
  });
}

/**
 * Latency-optimized search endpoint for UC1 (memory injection, <200ms target).
 * Skips the LLM repair loop which accounts for ~88% of search latency.
 */
function registerFastSearchRoute(
  router: Router,
  service: MemoryService,
  configRouteAdapter: RuntimeConfigRouteAdapter,
): void {
  router.post('/search/fast', validateBody(SearchBodySchema), async (req: Request, res: Response) => {
    try {
      const { body, effectiveConfig, scope, requestLimit } = readSearchRequest(req, res, configRouteAdapter);
      const retrievalOptions = {
        relevanceThreshold: body.relevanceThreshold,
      };
      const result = await service.scopedSearch(scope, body.query, {
        fast: true,
        sourceSite: body.sourceSite,
        limit: requestLimit,
        namespaceScope: body.namespaceScope,
        sessionId: body.sessionId,
        retrievalOptions,
        effectiveConfig,
      });
      res.json(formatSearchResponse(result, scope));
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/search/fast', err);
    }
  });
}

/**
 * POST /v1/memories/verify (Sprint 3 v1.7 — H5).
 *
 * Second-pass verifier: re-grounds a candidate answer against retrieved
 * context. The AMB harness calls this between its answer-LLM call and
 * scoring when `ATOMICMEMORY_VERIFIER_ENABLED=1` is set. Returns the
 * original answer if every specific is grounded, or a rewritten answer
 * if it dropped unsupported specifics.
 */
function registerVerifyRoute(router: Router): void {
  router.post('/verify', validateBody(VerifyBodySchema), async (req: Request, res: Response) => {
    try {
      const { question, context, candidateAnswer } = req.body as {
        question: string;
        context: string;
        candidateAnswer: string;
      };
      const result = await verifyAnswer(question, context, candidateAnswer);
      res.json({ verified_answer: result.verified_answer, changed: result.changed });
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/verify', err);
    }
  });
}

function registerExpandRoute(router: Router, service: MemoryService): void {
  router.post('/expand', validateBody(ExpandBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId, memoryIds, workspace } = req.body as {
        userId: string;
        memoryIds: string[];
        workspace: WorkspaceContext | undefined;
      };
      const scope = toMemoryScope(userId, workspace, undefined);
      const expanded = await service.scopedExpand(scope, memoryIds);
      res.json({ memories: expanded });
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/expand', err);
    }
  });
}

function registerListRoute(router: Router, service: MemoryService): void {
  router.get('/list', validateQuery(ListQuerySchema), async (req: Request, res: Response) => {
    try {
      const q = req.query as unknown as {
        userId: string;
        limit: number;
        offset: number;
        workspaceId: string | undefined;
        agentId: string | undefined;
        sourceSite: string | undefined;
        episodeId: string | undefined;
        sessionId: string | undefined;
      };
      const memories = q.workspaceId
        ? await service.scopedList({
            scope: { kind: 'workspace', userId: q.userId, workspaceId: q.workspaceId, agentId: q.agentId! },
            limit: q.limit,
            offset: q.offset,
            sessionId: q.sessionId,
          })
        : await service.list({
            userId: q.userId,
            limit: q.limit,
            offset: q.offset,
            sourceSite: q.sourceSite,
            episodeId: q.episodeId,
            sessionId: q.sessionId,
          });
      res.json({ memories, count: memories.length });
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/list', err);
    }
  });
}

function registerStatsRoute(router: Router, service: MemoryService): void {
  router.get('/stats', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const stats = await service.getStats(userId);
      res.json(formatStatsResponse(stats));
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/stats', err);
    }
  });
}

function registerHealthRoute(router: Router, configRouteAdapter: RuntimeConfigRouteAdapter): void {
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', config: formatHealthConfig(configRouteAdapter.current()) });
  });
}

function registerConfigRoute(router: Router, configRouteAdapter: RuntimeConfigRouteAdapter): void {
  router.put('/config', validateBody(ConfigBodySchema), async (req: Request, res: Response) => {
    try {
      if (!configRouteAdapter.current().runtimeConfigMutationEnabled) {
        res.status(410).json({
          error: 'PUT /v1/memories/config is deprecated for production',
          detail: 'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable runtime mutation in dev/test environments. Production deploys should use startup env vars.',
        });
        return;
      }
      const rejected = STARTUP_ONLY_CONFIG_FIELDS.filter((field) => (req.body as Record<string, unknown>)[field] !== undefined);
      if (rejected.length > 0) {
        res.status(400).json({
          error: 'Provider/model selection is startup-only',
          detail: `Fields ${rejected.join(', ')} cannot be mutated at runtime — the embedding/LLM provider caches are fixed at first use. Set the equivalent env vars (EMBEDDING_PROVIDER, EMBEDDING_MODEL, VOYAGE_API_KEY, VOYAGE_DOCUMENT_MODEL, VOYAGE_QUERY_MODEL, LLM_PROVIDER, LLM_MODEL) and restart the process.`,
          rejected,
        });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const applied = configRouteAdapter.update({
        similarityThreshold: body.similarity_threshold as number | undefined,
        audnCandidateThreshold: body.audn_candidate_threshold as number | undefined,
        clarificationConflictThreshold: body.clarification_conflict_threshold as number | undefined,
        maxSearchResults: body.max_search_results as number | undefined,
      });
      res.json({
        applied: applied.map(toSnakeCase),
        config: formatHealthConfig(configRouteAdapter.current()),
        note: 'Threshold updates applied in-memory for local experimentation. Provider/model selection is startup-only — restart the process to change it.',
      });
    } catch (err) {
      handleRouteError(res, 'PUT /v1/memories/config', err);
    }
  });
}

/**
 * GET /v1/memories/event-chains?user_id=X&entity_ids=uuid1,uuid2
 *
 * Returns per-entity chronological event chains from the Temporal Linkage
 * List. Entities with no events are dropped from the result. Within an
 * entity, events are ordered by position_in_chain ASC. Used by EO-shaped
 * read paths that need content alongside chain position. Returns
 * `{ chains: [] }` if TLL is disabled in the runtime config.
 */
function registerEventChainsRoute(router: Router, service: MemoryService): void {
  router.get('/event-chains', validateQuery(EventChainsQuerySchema), async (req: Request, res: Response) => {
    try {
      const q = req.query as unknown as { userId: string; entityIds: string[] };
      const chains = await service.getEventChains(q.userId, q.entityIds);
      res.json({
        chains: chains.map(c => ({
          entity_id: c.entityId,
          events: c.events.map(e => ({
            memory_id: e.memoryId,
            content: e.content,
            observation_date: e.observationDate.toISOString(),
            position_in_chain: e.positionInChain,
            predecessor_memory_id: e.predecessorMemoryId,
          })),
        })),
      });
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/event-chains', err);
    }
  });
}

/**
 * POST /v1/memories/first-mentions/extract
 *
 * Extract first-mention events from a conversation transcript and persist
 * them. Caller supplies the turn-id-to-memory-id mapping. Returns the
 * parsed events. Best-effort: if FirstMentionService is not wired or the
 * underlying LLM call fails, returns `{ events: [] }` without throwing.
 */
function registerFirstMentionsExtractRoute(router: Router, service: MemoryService): void {
  router.post(
    '/first-mentions/extract',
    validateBody(FirstMentionsExtractBodySchema),
    async (req: Request, res: Response) => {
      try {
        const b = req.body as unknown as {
          userId: string;
          conversationText: string;
          sourceSite: string;
          memoryIdsByTurnId: Map<number, string>;
        };
        const events = await service.extractFirstMentions(
          b.userId,
          b.conversationText,
          b.sourceSite,
          b.memoryIdsByTurnId,
        );
        res.json({
          events: events.map(e => ({
            topic: e.topic,
            turn_id: e.turnId,
            memory_id: e.memoryId,
            anchor_date: e.anchorDate ? e.anchorDate.toISOString() : null,
            position_in_conversation: e.positionInConversation,
          })),
        });
      } catch (err) {
        handleRouteError(res, 'POST /v1/memories/first-mentions/extract', err);
      }
    },
  );
}

function registerConsolidateRoute(router: Router, service: MemoryService): void {
  router.post('/consolidate', validateBody(ConsolidateBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId, execute } = req.body as { userId: string; execute: boolean };
      res.json(
        execute
          ? formatConsolidateExecuteResponse(await service.executeConsolidation(userId))
          : formatConsolidateResponse(await service.consolidate(userId)),
      );
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/consolidate', err);
    }
  });
}

function registerDecayRoute(router: Router, service: MemoryService): void {
  router.post('/decay', validateBody(DecayBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId, dryRun } = req.body as { userId: string; dryRun: boolean };
      const result = await service.evaluateDecay(userId);
      const archived = !dryRun && result.candidatesForArchival.length > 0
        ? await service.archiveDecayed(userId, result.candidatesForArchival.map((c) => c.id))
        : 0;
      res.json(formatDecayResponse(result, archived));
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/decay', err);
    }
  });
}

function registerCapRoute(router: Router, service: MemoryService): void {
  router.get('/cap', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const result = await service.checkCap(userId);
      res.json(formatCapResponse(result));
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/cap', err);
    }
  });
}

function registerLessonRoutes(router: Router, service: MemoryService): void {
  router.get('/lessons', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const lessons = await service.getLessons(userId);
      res.json({ lessons, count: lessons.length });
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/lessons', err);
    }
  });

  router.get('/lessons/stats', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const stats = await service.getLessonStats(userId);
      res.json(formatLessonStatsResponse(stats));
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/lessons/stats', err);
    }
  });

  router.post('/lessons/report', validateBody(LessonReportBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId, pattern, sourceMemoryIds, severity } = req.body as {
        userId: string;
        pattern: string;
        sourceMemoryIds: string[];
        severity: unknown;
      };
      const lessonId = await service.reportLesson(userId, pattern, sourceMemoryIds, severity as never);
      res.json({ lesson_id: lessonId });
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/lessons/report', err);
    }
  });

  router.delete(
    '/lessons/:id',
    validateParams(FreeIdParamSchema),
    validateQuery(UserIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params as unknown as { id: string };
        const { userId } = req.query as unknown as { userId: string };
        await service.deactivateLesson(userId, id);
        res.json({ success: true });
      } catch (err) {
        handleRouteError(res, 'DELETE /v1/memories/lessons/:id', err);
      }
    },
  );
}

function registerReconcileRoute(router: Router, service: MemoryService): void {
  router.post('/reconcile', validateBody(ReconcileBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.body as { userId: string | undefined };
      const result = userId
        ? await service.reconcileDeferred(userId)
        : await service.reconcileDeferredAll();
      res.json(formatReconciliationResponse(result));
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/reconcile', err);
    }
  });

  router.get('/reconcile/status', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const status = await service.getDeferredStatus(userId);
      res.json(status);
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/reconcile/status', err);
    }
  });
}

function registerResetSourceRoute(router: Router, service: MemoryService): void {
  router.post('/reset-source', validateBody(ResetSourceBodySchema), async (req: Request, res: Response) => {
    try {
      const { userId, sourceSite } = req.body as { userId: string; sourceSite: string };
      const result = await service.resetBySource(userId, sourceSite);
      res.json(formatResetSourceResponse(result));
    } catch (err) {
      handleRouteError(res, 'POST /v1/memories/reset-source', err);
    }
  });
}

function registerGetRoute(router: Router, service: MemoryService): void {
  router.get(
    '/:id',
    validateParams(UuidIdParamSchema),
    validateQuery(MemoryByIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { memoryId, q } = readMemoryByIdRequest(req);
        const memory = q.workspaceId
          ? await service.scopedGet(
              { kind: 'workspace', userId: q.userId, workspaceId: q.workspaceId, agentId: q.agentId! },
              memoryId,
            )
          : await service.get(memoryId, q.userId);
        if (!memory) {
          res.status(404).json({ error: 'Memory not found' });
          return;
        }
        res.json(memory);
      } catch (err) {
        handleRouteError(res, 'GET /v1/memories/:id', err);
      }
    },
  );
}

function registerDeleteRoute(router: Router, service: MemoryService): void {
  router.delete(
    '/:id',
    validateParams(UuidIdParamSchema),
    validateQuery(MemoryByIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { memoryId, q } = readMemoryByIdRequest(req);
        if (q.workspaceId) {
          const deleted = await service.scopedDelete(
            { kind: 'workspace', userId: q.userId, workspaceId: q.workspaceId, agentId: q.agentId! },
            memoryId,
          );
          if (!deleted) {
            res.status(404).json({ error: 'Memory not found' });
            return;
          }
        } else {
          await service.delete(memoryId, q.userId);
        }
        res.json({ success: true });
      } catch (err) {
        handleRouteError(res, 'DELETE /v1/memories/:id', err);
      }
    },
  );
}

function readMemoryByIdRequest(req: Request): { memoryId: string; q: MemoryByIdRouteQuery } {
  const { id: memoryId } = req.params as unknown as { id: string };
  return {
    memoryId,
    q: req.query as unknown as MemoryByIdRouteQuery,
  };
}

function registerAuditSummaryRoute(router: Router, service: MemoryService): void {
  router.get('/audit/summary', validateQuery(UserIdQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId } = req.query as unknown as { userId: string };
      const summary = await service.getMutationSummary(userId);
      res.json(formatMutationSummaryResponse(summary));
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/audit/summary', err);
    }
  });
}

function registerAuditRecentRoute(router: Router, service: MemoryService): void {
  router.get('/audit/recent', validateQuery(UserIdLimitQuerySchema), async (req: Request, res: Response) => {
    try {
      const { userId, limit } = req.query as unknown as { userId: string; limit: number };
      const mutations = await service.getRecentMutations(userId, limit);
      res.json({ mutations, count: mutations.length });
    } catch (err) {
      handleRouteError(res, 'GET /v1/memories/audit/recent', err);
    }
  });
}

function registerAuditTrailRoute(router: Router, service: MemoryService): void {
  router.get(
    '/:id/audit',
    validateParams(UuidIdParamSchema),
    validateQuery(UserIdQuerySchema),
    async (req: Request, res: Response) => {
      try {
        const { id: memoryId } = req.params as unknown as { id: string };
        const { userId } = req.query as unknown as { userId: string };
        const trail = await service.getAuditTrail(userId, memoryId);
        res.json({
          memory_id: memoryId,
          trail: trail.map(formatAuditTrailEntry),
          version_count: trail.length,
        });
      } catch (err) {
        handleRouteError(res, 'GET /v1/memories/:id/audit', err);
      }
    },
  );
}

function resolveEffectiveSearchLimit(
  requestedLimit: number | undefined,
  maxSearchResults: number,
): number {
  if (requestedLimit === undefined) return maxSearchResults;
  return Math.min(requestedLimit, maxSearchResults);
}

function toMemoryScope(
  userId: string,
  workspace: WorkspaceContext | undefined,
  agentScope: AgentScope | undefined,
): MemoryScope {
  if (!workspace) return { kind: 'user', userId };
  return { kind: 'workspace', userId, workspaceId: workspace.workspaceId, agentId: workspace.agentId, agentScope };
}

/**
 * Overlay a validated body-level config_override onto the startup
 * singleton and emit the observability response headers. Returns the
 * EffectiveConfig to hand to MemoryService (or undefined when no
 * override was present — the zero-cost no-headers path).
 *
 * Headers emitted when an override is applied:
 *   X-Atomicmem-Config-Override-Applied: true
 *   X-Atomicmem-Effective-Config-Hash:   sha256:<hex>
 *   X-Atomicmem-Config-Override-Keys:    comma-joined sorted key list
 *
 * Additional header, emitted only when one or more override keys do
 * not correspond to a known RuntimeConfig field on this build:
 *   X-Atomicmem-Unknown-Override-Keys:   comma-joined sorted key list
 *
 * Unknown keys are NOT rejected — the permissive schema is deliberate
 * so adding a new RuntimeConfig field in a future release doesn't
 * require a matching schema landing before experiments can set it.
 * Typos surface via this header + a server-side warning log.
 */
function applyRequestConfigOverride(
  res: Response,
  baseConfig: RuntimeConfig,
  override: Partial<RuntimeConfig> | undefined,
): MemoryServiceDeps['config'] | undefined {
  if (!override || Object.keys(override).length === 0) return undefined;
  const effective = applyConfigOverride(baseConfig, override);
  res.setHeader('X-Atomicmem-Config-Override-Applied', 'true');
  res.setHeader('X-Atomicmem-Effective-Config-Hash', hashEffectiveConfig(effective));
  res.setHeader('X-Atomicmem-Config-Override-Keys', summarizeOverrideKeys(override));

  const knownKeys = new Set(Object.keys(baseConfig));
  const unknownKeys = Object.keys(override)
    .filter((k) => !knownKeys.has(k))
    .sort();
  if (unknownKeys.length > 0) {
    res.setHeader('X-Atomicmem-Unknown-Override-Keys', unknownKeys.join(','));
    console.warn(
      `[config_override] request carried ${unknownKeys.length} unknown key(s): ${unknownKeys.join(', ')} — carried through on effective config but nothing currently reads them`,
    );
  }

  return effective;
}

function buildRetrievalObservability(result: RetrievalResult): RetrievalObservability | undefined {
  const observability: RetrievalObservability = {
    ...(result.retrievalSummary ? { retrieval: result.retrievalSummary } : {}),
    ...(result.packagingSummary ? { packaging: result.packagingSummary } : {}),
    ...(result.assemblySummary ? { assembly: result.assemblySummary } : {}),
  };

  return Object.keys(observability).length > 0 ? observability : undefined;
}

function applyCorsHeaders(req: Request, res: Response): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS_VALUE);
}


function readRuntimeConfigRouteSnapshot(): RuntimeConfigRouteSnapshot {
  return projectRuntimeConfigRouteSnapshot(config);
}

function toSnakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function formatHealthConfig(runtimeConfig: RuntimeConfigRouteSnapshot) {
  return {
    retrieval_profile: runtimeConfig.retrievalProfile,
    embedding_provider: runtimeConfig.embeddingProvider,
    embedding_model: runtimeConfig.embeddingModel,
    voyage_document_model: runtimeConfig.voyageDocumentModel,
    voyage_query_model: runtimeConfig.voyageQueryModel,
    llm_provider: runtimeConfig.llmProvider,
    llm_model: runtimeConfig.llmModel,
    clarification_conflict_threshold: runtimeConfig.clarificationConflictThreshold,
    max_search_results: runtimeConfig.maxSearchResults,
    hybrid_search_enabled: runtimeConfig.hybridSearchEnabled,
    iterative_retrieval_enabled: runtimeConfig.iterativeRetrievalEnabled,
    entity_graph_enabled: runtimeConfig.entityGraphEnabled,
    cross_encoder_enabled: runtimeConfig.crossEncoderEnabled,
    agentic_retrieval_enabled: runtimeConfig.agenticRetrievalEnabled,
    repair_loop_enabled: runtimeConfig.repairLoopEnabled,
  };
}

function formatSearchResponse(result: RetrievalResult, scope: MemoryScope) {
  const observability = buildRetrievalObservability(result);
  return {
    count: result.memories.length,
    retrieval_mode: result.retrievalMode,
    scope: formatScope(scope),
    memories: result.memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      similarity: memory.similarity,
      score: memory.score,
      semantic_similarity: memory.semantic_similarity ?? memory.similarity,
      ranking_score: memory.ranking_score ?? memory.score,
      relevance: memory.relevance ?? memory.similarity,
      importance: memory.importance,
      source_site: memory.source_site,
      session_id: memory.session_id,
      created_at: memory.created_at,
      metadata: memory.metadata,
    })),
    injection_text: result.injectionText,
    citations: result.citations,
    budget_constrained: result.budgetConstrained,
    ...(result.tierAssignments ? {
      tier_assignments: result.tierAssignments.map((a) => ({
        memory_id: a.memoryId,
        tier: a.tier,
        estimated_tokens: a.estimatedTokens,
      })),
    } : {}),
    ...(result.expandIds ? { expand_ids: result.expandIds } : {}),
    ...(result.estimatedContextTokens !== undefined ? {
      estimated_context_tokens: result.estimatedContextTokens,
    } : {}),
    ...(result.lessonCheck ? {
      lesson_check: {
        safe: result.lessonCheck.safe,
        warnings: result.lessonCheck.warnings,
        highest_severity: result.lessonCheck.highestSeverity,
        matched_count: result.lessonCheck.matchedLessons.length,
      },
    } : {}),
    ...(result.consensusResult ? {
      consensus: {
        original_count: result.consensusResult.originalCount,
        filtered_count: result.consensusResult.filteredCount,
        removed_count: result.consensusResult.removedMemoryIds.length,
        removed_memory_ids: result.consensusResult.removedMemoryIds,
      },
    } : {}),
    ...(observability ? { observability: formatObservability(observability) } : {}),
    ...(result.specialistAnswer ? { specialist_answer: result.specialistAnswer } : {}),
  };
}
