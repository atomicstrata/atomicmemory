/**
 * @file OpenAPI 3.1 registry — single source of truth for the spec.
 *
 * Wires every /v1/memories/*, /v1/agents/*, and /v1/documents/* route
 * into an OpenAPIRegistry. `scripts/generate-openapi.ts` walks this
 * registry to emit `openapi.yaml` + `openapi.json` at repo root.
 *
 * Each route entry records:
 *   - method + path (the public wire contract with the `/v1` prefix)
 *   - operationId (stable identifier clients can reference)
 *   - tag (groups routes under logical sections in the rendered docs)
 *   - request body and/or query / path params (Zod schemas from
 *     `./memories.ts` + `./agents.ts`)
 *   - per-route response inventory — includes every status code the
 *     real handler can emit, not a generic 200+400+500 default. The
 *     special 410 + rich-400 envelopes on PUT /config and 404 on
 *     GET/DELETE /:id are spelled out.
 */

import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from './zod-setup.js';
import {
  ErrorBasicSchema,
  ErrorConfig400Schema,
  ErrorConfig410Schema,
  ErrorUpstreamProviderSchema,
} from './errors.js';
import {
  IngestBodySchema,
  SearchBodySchema,
  ExpandBodySchema,
  ConsolidateBodySchema,
  DecayBodySchema,
  ReconcileBodySchema,
  ResetSourceBodySchema,
  LessonReportBodySchema,
  ConfigBodySchema,
  UserIdQuerySchema,
  UserIdLimitQuerySchema,
  ListQuerySchema,
  MemoryByIdQuerySchema,
  UuidIdParamSchema,
  FreeIdParamSchema,
} from './memories.js';
import {
  SetTrustBodySchema,
  GetTrustQuerySchema,
  UserIdFromQuerySchema,
  UserIdFromBodySchema,
  ConflictIdParamSchema,
  ResolveConflictBodySchema,
} from './agents.js';
import {
  RegisterDocumentBodySchema,
  DocumentIdParamSchema,
  DocumentByIdQuerySchema,
  ExtractionFailureBodySchema,
  IndexDocumentBodySchema,
  IndexFailureBodySchema,
  ListDocumentsQuerySchema,
  UploadRawDocumentQuerySchema,
} from './documents.js';
import {
  DocumentListRootQuerySchema,
  ListDocumentsWithoutMemoriesQuerySchema,
  PassportFeedQuerySchema,
} from './document-list-schemas.js';
import { PassportFeedResponseSchema } from './document-list-responses.js';
import {
  DeleteArtifactPolicySchema,
  DeleteArtifactResultSchema,
  PutArtifactBodySchema,
  StorageCapabilitiesResponseSchema,
  StoredArtifactResponseSchema,
  VerifyArtifactResultSchema,
} from './storage-schemas.js';
import * as R from './responses.js';

const TAG_MEMORIES = 'Memories';
const TAG_LIFECYCLE = 'Lifecycle';
const TAG_AUDIT = 'Audit';
const TAG_LESSONS = 'Lessons';
const TAG_CONFIG = 'Configuration';
const TAG_AGENTS = 'Agents';
const TAG_DOCUMENTS = 'Documents';
const TAG_STORAGE = 'Storage';
const TAG_ADMIN = 'Admin';

const AdminDeleteScopeBodySchema = z.object({
  user_id: z.string().min(1),
});
const AdminDeleteScopeResponseSchema = z.object({
  deleted: z.number().int().min(0),
});

/** Build and populate the OpenAPI registry. */
export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // Bearer auth scheme — matches the `requireBearer(coreApiKey)`
  // middleware mounted on every SDK-facing `/v1/*` router in
  // `create-app.ts`. The unversioned `/health` and `/openapi.json`
  // probes stay outside that scope, but neither is registered in
  // this OpenAPI surface so every documented route is auth-gated.
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      "Send `Authorization: Bearer <CORE_API_KEY>` on every request. " +
      'The key is the deployment-wide secret configured via ' +
      "`CORE_API_KEY`; the middleware uses constant-time comparison.",
  });
  registry.registerComponent('securitySchemes', 'adminBearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      'Send `Authorization: Bearer <CORE_ADMIN_API_KEY>` on admin-only ' +
      'cleanup requests. This scheme is separate from normal client auth.',
  });

  registry.register('ErrorBasic', ErrorBasicSchema);
  registry.register('ErrorConfig400', ErrorConfig400Schema);
  registry.register('ErrorConfig410', ErrorConfig410Schema);
  registry.register('ErrorUpstreamProvider', ErrorUpstreamProviderSchema);
  registry.register('AdminDeleteScopeBody', AdminDeleteScopeBodySchema);
  registry.register('AdminDeleteScopeResponse', AdminDeleteScopeResponseSchema);

  registerMemoryCoreRoutes(registry);
  registerMemoryLifecycleRoutes(registry);
  registerMemoryAuditRoutes(registry);
  registerMemoryLessonRoutes(registry);
  registerMemoryConfigRoutes(registry);
  registerAgentRoutes(registry);
  registerDocumentRoutes(registry);
  registerStorageRoutes(registry);
  registerAdminRoutes(registry);

  return registry;
}

// ---------------------------------------------------------------------------
// Shared response-object builders
// ---------------------------------------------------------------------------

const RESPONSE_400 = {
  description: 'Input validation error',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_401 = {
  description: 'Missing or invalid bearer token',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_403 = {
  description: 'Request is authenticated but not allowed',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_500 = {
  description: 'Internal server error',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};
const RESPONSE_502 = {
  description:
    'Upstream AI provider returned an unrecoverable failure (auth, non-retryable 4xx).',
  content: { 'application/json': { schema: ErrorUpstreamProviderSchema } },
};
const RESPONSE_503 = {
  description:
    'Upstream AI provider is rate-limited, quota-exhausted, or returned 5xx; consult `retryable`.',
  content: { 'application/json': { schema: ErrorUpstreamProviderSchema } },
};
const RESPONSE_404 = {
  description: 'Memory not found',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};

/** Catch-all schema used for responses whose internal shape is large + still evolving. */
const GenericObjectResponse = z.object({}).passthrough();

function ok(description: string, schema: z.ZodTypeAny = GenericObjectResponse) {
  return { description, content: { 'application/json': { schema } } };
}

// ---------------------------------------------------------------------------
// /v1/memories — core routes (ingest, search, expand, list, get, delete)
// ---------------------------------------------------------------------------

function registerMemoryCoreRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/v1/memories/ingest',
    operationId: 'ingestMemory',
    tags: [TAG_MEMORIES],
    summary: 'Ingest a conversation transcript with full extraction.',
    description:
      'Full-extraction ingest. The `metadata` field on the body schema is ' +
      '**rejected with 400** on this route — caller metadata is only supported ' +
      'on `POST /v1/memories/ingest/quick` with `skip_extraction=true` and no ' +
      'workspace context.',
    request: { body: { content: { 'application/json': { schema: IngestBodySchema } }, required: true } },
    responses: {
      200: ok('Ingest result with extracted facts.', R.IngestResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/ingest/quick',
    operationId: 'ingestMemoryQuick',
    tags: [TAG_MEMORIES],
    summary: 'Quick ingest (storeVerbatim when skip_extraction=true).',
    description:
      'Quick or verbatim ingest. The `metadata` field is **honored only** when ' +
      '`skip_extraction=true` and no workspace context (`workspace_id` / ' +
      '`agent_id` / `visibility`) is provided; otherwise rejected with 400.',
    request: { body: { content: { 'application/json': { schema: IngestBodySchema } }, required: true } },
    responses: {
      200: ok('Ingest result.', R.IngestResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/search',
    operationId: 'searchMemories',
    tags: [TAG_MEMORIES],
    summary: 'Full semantic search with optional temporal / retrieval-mode / token-budget controls.',
    request: { body: { content: { 'application/json': { schema: SearchBodySchema } }, required: true } },
    responses: {
      200: ok('Search results with injection_text and citations.', R.SearchResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/search/fast',
    operationId: 'searchMemoriesFast',
    tags: [TAG_MEMORIES],
    summary: 'Latency-optimized search (skips LLM repair loop). ~88% lower latency than /search.',
    request: { body: { content: { 'application/json': { schema: SearchBodySchema } }, required: true } },
    responses: {
      200: ok('Search results.', R.SearchResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/expand',
    operationId: 'expandMemories',
    tags: [TAG_MEMORIES],
    summary: 'Expand a list of memory IDs into full objects.',
    request: { body: { content: { 'application/json': { schema: ExpandBodySchema } }, required: true } },
    responses: {
      200: ok('Expanded memories array.', R.ExpandResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/list',
    operationId: 'listMemories',
    tags: [TAG_MEMORIES],
    summary: 'List memories for a user (or workspace).',
    request: { query: ListQuerySchema },
    responses: {
      200: ok('Paginated memory list.', R.ListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/{id}',
    operationId: 'getMemory',
    tags: [TAG_MEMORIES],
    summary: 'Fetch a single memory by UUID.',
    request: { params: UuidIdParamSchema, query: MemoryByIdQuerySchema },
    responses: {
      200: ok('Memory object.', R.GetMemoryResponseSchema),
      400: RESPONSE_400,
      404: RESPONSE_404,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/memories/{id}',
    operationId: 'deleteMemory',
    tags: [TAG_MEMORIES],
    summary: 'Delete a single memory by UUID.',
    request: { params: UuidIdParamSchema, query: MemoryByIdQuerySchema },
    responses: {
      200: ok('Deletion success.', R.SuccessResponseSchema),
      400: RESPONSE_400,
      404: RESPONSE_404,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/stats',
    operationId: 'getStats',
    tags: [TAG_MEMORIES],
    summary: 'Aggregate memory statistics for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Stats payload.', R.StatsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — lifecycle admin ops
// ---------------------------------------------------------------------------

function registerMemoryLifecycleRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/v1/memories/consolidate',
    operationId: 'consolidateMemories',
    tags: [TAG_LIFECYCLE],
    summary: 'Compute consolidation candidates; optionally execute (execute=true).',
    request: { body: { content: { 'application/json': { schema: ConsolidateBodySchema } }, required: true } },
    responses: {
      200: ok('Consolidation result.', R.ConsolidateResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/decay',
    operationId: 'evaluateDecay',
    tags: [TAG_LIFECYCLE],
    summary: 'Evaluate decay candidates. dry_run=false archives them.',
    request: { body: { content: { 'application/json': { schema: DecayBodySchema } }, required: true } },
    responses: {
      200: ok('Decay evaluation + archived count.', R.DecayResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/cap',
    operationId: 'checkMemoryCap',
    tags: [TAG_LIFECYCLE],
    summary: "Memory-cap status for a user's store.",
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Cap status.', R.CapResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/reconcile',
    operationId: 'reconcileDeferred',
    tags: [TAG_LIFECYCLE],
    summary: 'Reconcile deferred mutations for a user (or all users when user_id is absent).',
    request: { body: { content: { 'application/json': { schema: ReconcileBodySchema } }, required: false } },
    responses: {
      200: ok('Reconciliation result.', R.ReconciliationResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/reconcile/status',
    operationId: 'getReconcileStatus',
    tags: [TAG_LIFECYCLE],
    summary: 'Get deferred-mutation reconciliation status.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Status payload.', R.ReconcileStatusResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/reset-source',
    operationId: 'resetBySource',
    tags: [TAG_LIFECYCLE],
    summary: 'Delete all memories for a given user + source_site.',
    request: { body: { content: { 'application/json': { schema: ResetSourceBodySchema } }, required: true } },
    responses: {
      200: ok('Reset result.', R.ResetSourceResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — audit
// ---------------------------------------------------------------------------

function registerMemoryAuditRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/audit/summary',
    operationId: 'getAuditSummary',
    tags: [TAG_AUDIT],
    summary: "Aggregate mutation statistics for a user's memory store.",
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Mutation summary.', R.MutationSummaryResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/audit/recent',
    operationId: 'getRecentAudit',
    tags: [TAG_AUDIT],
    summary: 'Recent mutations for a user, limit-bounded.',
    request: { query: UserIdLimitQuerySchema },
    responses: {
      200: ok('Recent mutations.', R.AuditRecentResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/{id}/audit',
    operationId: 'getMemoryAuditTrail',
    tags: [TAG_AUDIT],
    summary: 'Per-memory version history.',
    request: { params: UuidIdParamSchema, query: UserIdQuerySchema },
    responses: {
      200: ok('Audit trail.', R.AuditTrailResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — lessons
// ---------------------------------------------------------------------------

function registerMemoryLessonRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/lessons',
    operationId: 'listLessons',
    tags: [TAG_LESSONS],
    summary: 'List active lessons for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Lessons list.', R.LessonsListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/memories/lessons/stats',
    operationId: 'getLessonStats',
    tags: [TAG_LESSONS],
    summary: 'Lesson statistics for a user.',
    request: { query: UserIdQuerySchema },
    responses: {
      200: ok('Stats.', R.LessonStatsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/memories/lessons/report',
    operationId: 'reportLesson',
    tags: [TAG_LESSONS],
    summary: 'Report a new lesson.',
    request: { body: { content: { 'application/json': { schema: LessonReportBodySchema } }, required: true } },
    responses: {
      200: ok('Lesson id.', R.LessonReportResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/memories/lessons/{id}',
    operationId: 'deactivateLesson',
    tags: [TAG_LESSONS],
    summary: 'Deactivate a lesson by id.',
    request: { params: FreeIdParamSchema, query: UserIdQuerySchema },
    responses: {
      200: ok('Success.', R.SuccessResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/memories — config + health
// ---------------------------------------------------------------------------

function registerMemoryConfigRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/memories/health',
    operationId: 'getMemoryHealth',
    tags: [TAG_CONFIG],
    summary: 'Subsystem liveness + current runtime config snapshot.',
    responses: {
      200: ok('Status + config snapshot.', R.HealthResponseSchema),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/memories/config',
    operationId: 'updateConfig',
    tags: [TAG_CONFIG],
    summary: 'Mutate runtime config (dev/test only). 410 when disabled.',
    description:
      'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable. Startup-only fields (embedding_provider/model, llm_provider/model) return 400 with a `rejected` array listing the offending fields.',
    request: { body: { content: { 'application/json': { schema: ConfigBodySchema } }, required: true } },
    responses: {
      200: ok('Applied changes + config snapshot.', R.ConfigUpdateResponseSchema),
      400: {
        // Two shapes are possible:
        //   1. Basic `{ error }` when the validateBody middleware
        //      catches a schema violation on the request body.
        //   2. Richer `{ error, detail, rejected }` when the handler
        //      detects startup-only fields (embedding_provider etc.).
        description: 'Input validation error OR startup-only fields were supplied.',
        content: {
          'application/json': {
            schema: {
              oneOf: [
                { $ref: '#/components/schemas/ErrorBasic' },
                { $ref: '#/components/schemas/ErrorConfig400' },
              ],
            },
          },
        },
      },
      410: {
        description: 'Runtime config mutation is disabled in production.',
        content: { 'application/json': { schema: ErrorConfig410Schema } },
      },
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/admin — maintenance routes
// ---------------------------------------------------------------------------

function registerAdminRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'delete',
    path: '/v1/admin/scope',
    operationId: 'deleteAdminScope',
    tags: [TAG_ADMIN],
    summary: 'Delete one allowed disposable test scope.',
    description:
      'Mounted only when CORE_ADMIN_API_KEY and CORE_TEST_SCOPE_ALLOW_PATTERN ' +
      'are both configured. The server refuses user_id values that do not ' +
      'match the configured test-scope pattern.',
    security: [{ adminBearerAuth: [] }],
    request: {
      body: {
        content: { 'application/json': { schema: AdminDeleteScopeBodySchema } },
        required: true,
      },
    },
    responses: {
      200: ok('Number of memories deleted for the requested scope.', AdminDeleteScopeResponseSchema),
      400: RESPONSE_400,
      401: RESPONSE_401,
      403: RESPONSE_403,
      500: RESPONSE_500,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/agents
// ---------------------------------------------------------------------------

function registerAgentRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'put',
    path: '/v1/agents/trust',
    operationId: 'setAgentTrust',
    tags: [TAG_AGENTS],
    summary: "Set the calling user's trust level for a given agent.",
    request: { body: { content: { 'application/json': { schema: SetTrustBodySchema } }, required: true } },
    responses: {
      200: ok('Agent id + applied trust level.', R.TrustResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/agents/trust',
    operationId: 'getAgentTrust',
    tags: [TAG_AGENTS],
    summary: 'Look up the trust level for a (user, agent) pair.',
    request: { query: GetTrustQuerySchema },
    responses: {
      200: ok('Agent id + trust level.', R.TrustResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/agents/conflicts',
    operationId: 'listAgentConflicts',
    tags: [TAG_AGENTS],
    summary: 'List open agent conflicts for a user.',
    request: { query: UserIdFromQuerySchema },
    responses: {
      200: ok('Conflicts list.', R.ConflictsListResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/agents/conflicts/{id}/resolve',
    operationId: 'resolveAgentConflict',
    tags: [TAG_AGENTS],
    summary: 'Resolve a specific conflict with one of the three enum variants.',
    request: {
      params: ConflictIdParamSchema,
      body: { content: { 'application/json': { schema: ResolveConflictBodySchema } }, required: true },
    },
    responses: {
      200: ok('Resolution confirmation.', R.ResolveConflictResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/agents/conflicts/auto-resolve',
    operationId: 'autoResolveAgentConflicts',
    tags: [TAG_AGENTS],
    summary: 'Auto-resolve all expired conflicts for a user.',
    request: { body: { content: { 'application/json': { schema: UserIdFromBodySchema } }, required: true } },
    responses: {
      200: ok('Count of resolved conflicts.', R.AutoResolveConflictsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/documents — pointer-only registration. Managed-blob ingestion uses
// the upload route after registration; the registration body rejects
// `storage_mode` values other than `pointer_only` with a 400.
// ---------------------------------------------------------------------------

const DOCUMENT_NOT_FOUND_RESPONSE = {
  description: 'Document not found',
  content: { 'application/json': { schema: ErrorBasicSchema } },
};

function registerDocumentRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/v1/documents',
    operationId: 'registerDocument',
    tags: [TAG_DOCUMENTS],
    summary: 'Register a pointer-only document.',
    description:
      'Idempotent on (user_id, source_site, provider, external_id, provider_version). ' +
      'Returns 201 on first registration; 200 on a re-register that matches an active ' +
      "row. Registration accepts `storage_mode = 'pointer_only'`; managed_blob and " +
      'inline_small_text return 400.',
    request: {
      body: { content: { 'application/json': { schema: RegisterDocumentBodySchema } }, required: true },
    },
    responses: {
      200: ok('Idempotent re-registration; document already existed.', R.RegisterDocumentResponseSchema),
      201: ok('Document registered.', R.RegisterDocumentResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents/limits',
    operationId: 'getDocumentLimits',
    tags: [TAG_DOCUMENTS],
    summary: 'Read upload + index byte caps and raw-storage capability.',
    description:
      'Public preflight surface. Clients call this to size requests and ' +
      'decide whether to attempt a managed-blob upload. The values are a ' +
      'composition-time snapshot of the runtime config; no PII, no ' +
      'per-user state. Mirrors the auth posture of `/health`.',
    responses: {
      200: ok('Document limits + raw_storage capability.', R.DocumentLimitsResponseSchema),
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents/list',
    operationId: 'listDocuments',
    tags: [TAG_DOCUMENTS],
    summary: 'List active documents for a user, optionally filtered by source_site.',
    request: { query: ListDocumentsQuerySchema },
    responses: {
      200: ok('Document list with count.', R.ListDocumentsResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents/passport-feed',
    operationId: 'listPassportFeed',
    tags: [TAG_DOCUMENTS],
    summary: 'Memory-backed passport feed: grouped doc rows + standalone memories.',
    description:
      'Single SQL UNION ALL: one row per documentId-with-' +
      'memories (grouped on `raw_document_id`, joined to ' +
      '`raw_documents` for the status envelope) plus 1:1 ' +
      'standalone-memory rows (memories whose `raw_document_id IS ' +
      'NULL`). Sorted by `(sort_at DESC, sort_id DESC)`; the webapp ' +
      "passport route consumes this as the memory-feed stream of its " +
      'server-side two-stream merge. Cursor + limit semantics match ' +
      'the other document list routes; opaque `next_cursor` is the ' +
      'tuple of the last consumed row.',
    request: { query: PassportFeedQuerySchema },
    responses: {
      200: ok('Passport feed page.', PassportFeedResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents/without-memories',
    operationId: 'listDocumentsWithoutMemories',
    tags: [TAG_DOCUMENTS],
    summary: 'Documents WITHOUT non-deleted memories, narrowed by recovery-status filter.',
    description:
      'Backs the passport synthetic-row stream and the UI ' +
      '"uploaded but unindexed" surface. A row appears when it has ' +
      'zero non-deleted memories AND at least one layer status sits in ' +
      "the supplied filter. Filter omitted -> server default '" +
      "recovery-relevant set (extraction in pending/failed/unsupported, " +
      "semantic_index in pending/failed, raw_storage in raw_storage_failed). " +
      'Cursor + limit semantics match `GET /v1/documents`.',
    request: { query: ListDocumentsWithoutMemoriesQuerySchema },
    responses: {
      200: ok('Cursor-paginated unbacked-document list.', R.DocumentListRootResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents',
    operationId: 'listDocumentsForUser',
    tags: [TAG_DOCUMENTS],
    summary: 'Cursor-paginated user-scoped document list with status-bucket filter.',
    description:
      'Returns active documents for the supplied `user_id`, ' +
      'ordered `(created_at DESC, id DESC)`. The opaque `cursor` is the ' +
      '`next_cursor` from the previous page (base64-url JSON tuple); ' +
      'malformed cursors return 400. The `status` query param buckets ' +
      "rows for the recovery surfaces: `'failed'` (any layer failed), " +
      "`'unsupported'` (extraction marked unsupported), `'pending'` " +
      "(extraction or semantic_index in pending/running), or `'all'` " +
      '(default — every active row).',
    request: { query: DocumentListRootQuerySchema },
    responses: {
      200: ok('Cursor-paginated document list.', R.DocumentListRootResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/documents/{id}',
    operationId: 'getDocument',
    tags: [TAG_DOCUMENTS],
    summary: 'Fetch a single document by UUID.',
    request: { params: DocumentIdParamSchema, query: DocumentByIdQuerySchema },
    responses: {
      200: ok('Document record.', R.RawDocumentResponseSchema),
      400: RESPONSE_400,
      404: DOCUMENT_NOT_FOUND_RESPONSE,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/documents/{id}',
    operationId: 'deleteDocument',
    tags: [TAG_DOCUMENTS],
    summary: 'Soft-delete (tombstone) a document.',
    description:
      'Idempotent: a second DELETE on the same id returns success with ' +
      '`already_deleted: true`. Subsequent GETs of the deleted id return 404.',
    request: { params: DocumentIdParamSchema, query: DocumentByIdQuerySchema },
    responses: {
      200: ok('Soft-delete acknowledgement.', R.DeleteDocumentResponseSchema),
      400: RESPONSE_400,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/documents/{id}/index',
    operationId: 'indexDocument',
    tags: [TAG_DOCUMENTS],
    summary: 'Chunk + embed text for a registered document.',
    description:
      'Deterministic char-window chunking, batched embeddings via the ' +
      "core embedding provider, and one provenance-linked memory per chunk. " +
      'Idempotent on byte-identical text under the current chunker_version: ' +
      "the response's `idempotent_skip` flag indicates whether work was performed. " +
      'A re-index with new text soft-deletes the prior generation of chunks + ' +
      'derived memories before inserting the fresh one.',
    request: {
      params: DocumentIdParamSchema,
      body: { content: { 'application/json': { schema: IndexDocumentBodySchema } }, required: true },
    },
    responses: {
      200: ok('Indexing result with chunk + memory counts.', R.IndexDocumentResponseSchema),
      400: RESPONSE_400,
      404: DOCUMENT_NOT_FOUND_RESPONSE,
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/v1/documents/{id}/raw',
    operationId: 'uploadRawDocument',
    tags: [TAG_DOCUMENTS],
    summary: 'Upload managed raw bytes for a registered document.',
    description:
      'Stores the request body as the document\'s managed blob via the ' +
      "configured `RawContentStore` adapter (`local_fs` or `s3`), and " +
      "promotes the document row to `storage_mode='managed_blob'` / " +
      "`raw_storage_status='blob_stored'`. Idempotent on byte-identical " +
      'input under the same document. Different bytes against an already-' +
      'stored managed blob return 409 because the managed slot is ' +
      'immutable per row to avoid orphaning the prior blob. Returns 503 ' +
      "when the deployment runs `rawStorageMode='pointer_only'`.",
    request: {
      params: DocumentIdParamSchema,
      query: UploadRawDocumentQuerySchema,
      body: {
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' },
          },
        },
        required: true,
      },
    },
    responses: {
      200: ok('Upload result with storage URI + content hash + size.', R.UploadRawDocumentResponseSchema),
      400: RESPONSE_400,
      404: DOCUMENT_NOT_FOUND_RESPONSE,
      409: {
        description:
          'Conflict: the document already has a managed blob with a ' +
          'different content_hash. Register a fresh document for the ' +
          'new bytes — the existing blob is not overwritten.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/documents/{id}/extraction-failure',
    operationId: 'markExtractionFailure',
    tags: [TAG_DOCUMENTS],
    summary: 'Mark the document as extraction-failed.',
    description:
      'Service-owned status transition: callers declare *that* extraction ' +
      'failed and *what category* via a bounded `error_code`. The route ' +
      'service-truncates `error_message` to a fixed cap and rejects ' +
      'arbitrary status combinations. Idempotent on retry; 409 on ' +
      'invalid source state with the row\'s current per-layer status ' +
      'echoed in the response body.',
    request: {
      params: DocumentIdParamSchema,
      body: { content: { 'application/json': { schema: ExtractionFailureBodySchema } }, required: true },
    },
    responses: {
      200: ok('Marker write acknowledgement; durable row echoed.', R.DocumentFailureMarkerResponseSchema),
      400: RESPONSE_400,
      404: DOCUMENT_NOT_FOUND_RESPONSE,
      409: {
        description:
          'Invalid extraction state transition. The response body ' +
          'echoes `current.{raw_storage_status,extraction_status,semantic_index_status}` ' +
          'so the caller can reason about retries.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/documents/{id}/index-failure',
    operationId: 'markIndexFailure',
    tags: [TAG_DOCUMENTS],
    summary: 'Mark the document as index-failed.',
    description:
      'Service-owned status transition. The `index_text_too_large` ' +
      "code on a `extraction_status='pending'` row atomically " +
      "advances extraction to `'complete'` AND writes " +
      "`semantic_index_status='failed'` so the durable row reflects " +
      'the upload-pipeline sequence. Idempotent on retry; 409 on ' +
      'invalid source state.',
    request: {
      params: DocumentIdParamSchema,
      body: { content: { 'application/json': { schema: IndexFailureBodySchema } }, required: true },
    },
    responses: {
      200: ok('Marker write acknowledgement; durable row echoed.', R.DocumentFailureMarkerResponseSchema),
      400: RESPONSE_400,
      404: DOCUMENT_NOT_FOUND_RESPONSE,
      409: {
        description: 'Invalid index state transition; current per-layer status echoed.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });
}

function registerStorageRoutes(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/storage/capabilities',
    operationId: 'getStorageCapabilities',
    tags: [TAG_STORAGE],
    summary: 'Read the direct storage API capability snapshot.',
    description:
      'Public preflight surface for the storage API. Clients call ' +
      'this before attempting a managed-mode artifact upload. The ' +
      'response describes what the direct `/v1/storage/artifacts/*` ' +
      'API supports for the active backend — Filecoin direct managed ' +
      'upload is not yet supported in v1, so every capability flag ' +
      'reports `false` for Filecoin here. Filecoin still has full ' +
      'feature support through document ingestion (see ' +
      '`/v1/documents/limits`).',
    responses: {
      200: ok(
        'Capability snapshot for the direct storage API.',
        StorageCapabilitiesResponseSchema,
      ),
      500: RESPONSE_500,
      502: RESPONSE_502,
      503: RESPONSE_503,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/storage/artifacts',
    operationId: 'putStorageArtifact',
    tags: [TAG_STORAGE],
    summary: 'Register a pointer artifact or upload a managed artifact.',
    description:
      'Pointer mode sends a JSON body with `mode: "pointer"` plus a ' +
      'caller-supplied `uri`; the server stores the reference but ' +
      'NEVER fetches the URI. Managed mode sends the raw bytes with ' +
      '`?mode=managed[&disclose_content_hash=true]` and an optional ' +
      '`X-AtomicMemory-Metadata` base64-JSON header. Filecoin direct ' +
      'managed uploads return 501 in v1.',
    request: {
      body: {
        content: { 'application/json': { schema: PutArtifactBodySchema } },
        required: true,
      },
    },
    responses: {
      201: ok('Artifact created.', StoredArtifactResponseSchema),
      400: RESPONSE_400,
      411: {
        description: 'Content-Length is required for managed uploads.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      413: {
        description: 'Managed upload body exceeds the configured cap.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      501: {
        description: 'Direct Filecoin managed upload is not supported in v1.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      503: {
        description: 'Managed storage is disabled for this deployment.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/storage/artifacts/{id}',
    operationId: 'getStorageArtifact',
    tags: [TAG_STORAGE],
    summary: 'Read an artifact metadata projection.',
    request: { params: UuidIdParamSchema },
    responses: {
      200: ok('Artifact metadata.', StoredArtifactResponseSchema),
      404: {
        description: 'Artifact not found.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/storage/artifacts/{id}/content',
    operationId: 'getStorageArtifactContent',
    tags: [TAG_STORAGE],
    summary: 'Read the raw bytes for a managed artifact.',
    description:
      'Returns the artifact bytes for managed-mode artifacts. ' +
      'Pointer-mode artifacts return 409 `pointer_content_not_managed` — ' +
      'the server never proxies pointer content.',
    request: { params: UuidIdParamSchema },
    responses: {
      200: { description: 'Raw bytes.' },
      404: {
        description: 'Artifact not found.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      409: {
        description: 'Pointer-mode artifact; fetch the URI directly.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      503: {
        description: 'Managed storage is disabled for this deployment.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/v1/storage/artifacts/{id}',
    operationId: 'deleteStorageArtifact',
    tags: [TAG_STORAGE],
    summary: 'Soft-delete an artifact (optionally cascading documents).',
    description:
      "Reference-aware delete. Default `policy=artifact_only` returns " +
      '409 `artifact_in_use` if any active document references the ' +
      'artifact; `policy=with_documents` cascades a soft-delete to ' +
      'those documents first. No `force` parameter is supported.',
    request: {
      params: UuidIdParamSchema,
      query: z.object({ policy: DeleteArtifactPolicySchema.optional() }).strict(),
    },
    responses: {
      200: ok('Artifact deleted (or delete failed at the backend).', DeleteArtifactResultSchema),
      400: RESPONSE_400,
      404: {
        description: 'Artifact not found.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      409: {
        description:
          'Artifact is referenced by active documents ' +
          '(`error_code: artifact_in_use`) OR another caller holds an ' +
          'active delete claim and this caller never ran the delete ' +
          '(`error_code: delete_in_flight`, `retryable: true`).',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/storage/artifacts/{id}/verify',
    operationId: 'verifyStorageArtifact',
    tags: [TAG_STORAGE],
    summary: "Run the backend's verification (head-probe in v1).",
    description:
      "Pointer-mode artifacts always return `kind: 'unsupported'` — " +
      'the server never fetches the registered URI.',
    request: { params: UuidIdParamSchema },
    responses: {
      200: ok('Verification result.', VerifyArtifactResultSchema),
      404: {
        description: 'Artifact not found.',
        content: { 'application/json': { schema: ErrorBasicSchema } },
      },
      500: RESPONSE_500,
    },
  });
}
