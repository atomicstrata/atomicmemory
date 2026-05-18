/**
 * Core runtime container — the explicit composition root for atomicmemory-core.
 *
 * Owns the construction of config, pool, repositories, and services so
 * startup (`server.ts`), tests, and in-process research harnesses all boot
 * through the same seam. Replaces the hidden singleton wiring that used to
 * live inline in `server.ts`.
 *
 * Runtime-container wiring — the composition root that replaces
 * per-startup hand-wiring of repos and services in `server.ts`.
 */

import pg from 'pg';
import {
  applyRuntimeConfigUpdates,
  config as defaultConfig,
  type CrossEncoderDtype,
  type RuntimeConfig,
  type RuntimeConfigUpdates,
} from '../config.js';
import { AgentTrustRepository } from '../db/agent-trust-repository.js';
import { BeliefEdgesRepository } from '../db/belief-edges-repository.js';
import { ClaimRepository } from '../db/claim-repository.js';
import { LinkRepository } from '../db/link-repository.js';
import { MemoryRepository } from '../db/memory-repository.js';
import { EntityRepository } from '../db/repository-entities.js';
import { EntityAttributesRepository } from '../db/repository-entity-attributes.js';
import { LessonRepository } from '../db/repository-lessons.js';
import { SummariesRepository } from '../db/summaries-repository.js';
import { UserProfileRepository } from '../db/repository-user-profiles.js';
import { ReflectionsRepository } from '../db/reflections-repository.js';
import { ReflectionJobsRepository } from '../db/reflection-jobs-repository.js';
import { EntityCardsRepository } from '../db/entity-cards-repository.js';
import { ContradictionsRepository } from '../db/contradictions-repository.js';
import { EntityValuesRepository } from '../db/entity-values-repository.js';
import { TllRepository } from '../db/repository-tll.js';
import { FirstMentionRepository } from '../db/repository-first-mentions.js';
import { DocumentService } from '../services/document-service.js';
import { StorageService } from '../services/storage-service.js';
import { RawContentStoreBackendAdapter } from '../storage/raw-content-store-backend-adapter.js';
import { buildBackendRegistry } from '../storage/storage-backend-registry.js';
import { buildRawContentStore, buildLegacyStores } from '../storage/factory.js';
import type { RawContentStore } from '../storage/raw-content-store.js';
import { buildStoreRegistry, type RawContentStoreRegistry } from '../storage/store-registry.js';
import { buildRawContentCodec } from '../storage/codec-factory.js';
import { FirstMentionService } from '../services/first-mention-service.js';
import { llm } from '../services/llm.js';
import type { CoreStores } from '../db/stores.js';
import { PgMemoryStore } from '../db/pg-memory-store.js';
import { PgEpisodeStore } from '../db/pg-episode-store.js';
import { PgRecapStore } from '../db/pg-recap-store.js';
import { PgSearchStore } from '../db/pg-search-store.js';
import { PgSemanticLinkStore } from '../db/pg-link-store.js';
import { PgRepresentationStore } from '../db/pg-representation-store.js';
import type { RetrievalProfile } from '../services/retrieval-profiles.js';
import { MemoryService } from '../services/memory-service.js';
import { initEmbedding, embedText } from '../services/embedding.js';
import { initLlm, callAnthropicTool } from '../services/llm.js';
import { runReflectForConversation } from '../services/reflect.js';
import { startReflectWorker } from '../services/reflect-jobs.js';
import { setBeliefDualWriteHook } from '../services/tbc-execution.js';
import {
  readRuntimeConfigRouteSnapshot,
  type RuntimeConfigRouteSnapshot,
} from './runtime-config-route-snapshot.js';

/**
 * Explicit runtime configuration subset currently needed by the runtime
 * container, startup checks, search/runtime seams, and MemoryService deps.
 *
 * This is intentionally narrower than the module-level config singleton:
 * it describes the config surface already threaded through those seams
 * today, without claiming full runtime-wide configurability yet.
 *
 * NOTE (phase 1b status): `runtime.config` is normally the module-level
 * singleton, but benchmark harnesses may pass an explicit composition-time
 * RuntimeConfig through `createCoreRuntime({ config })`. MemoryService accepts
 * an optional runtimeConfig override (stored as deps.config), and the search-
 * pipeline orchestration and ingest orchestration files (memory-ingest,
 * memory-storage, memory-audn, memory-lineage) read the fields listed
 * in `CoreRuntimeConfig` and `IngestRuntimeConfig` through deps.config
 * rather than the singleton. The route layer reads through an injectable
 * adapter seam (`configRouteAdapter`) backed by this runtime config object.
 *
 * Leaf modules initialized by this composition root (embedding.ts and llm.ts)
 * are rebound to the runtime config. Other leaf helpers still import the
 * singleton directly, so config overrides are intended for isolated single-
 * runtime harnesses, not multiple concurrently-active runtimes in one process.
 *
 * Remaining singleton importers: 33 non-test source files (tracked by
 * config-singleton-audit.test.ts). This includes infrastructure, CRUD/
 * lifecycle, leaf helpers, the DB repository layer, and index.ts.
 */
export interface CoreRuntimeConfig {
  adaptiveRetrievalEnabled: boolean;
  adaptiveSimpleLimit: number;
  adaptiveMediumLimit: number;
  adaptiveComplexLimit: number;
  adaptiveMultiHopLimit: number;
  adaptiveAggregationLimit: number;
  agenticRetrievalEnabled: boolean;
  auditLoggingEnabled: boolean;
  consensusMinMemories: number;
  consensusValidationEnabled: boolean;
  crossEncoderDtype: CrossEncoderDtype;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  embeddingDimensions: number;
  entityGraphEnabled: boolean;
  entitySearchMinSimilarity: number;
  hierarchicalRetrievalEnabled: boolean;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  lessonsEnabled: boolean;
  linkExpansionBeforeMMR: boolean;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  literalListProtectionEnabled: boolean;
  literalListProtectionMaxProtected: number;
  maxSearchResults: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  namespaceClassificationEnabled: boolean;
  pprDamping: number;
  pprEnabled: boolean;
  port: number;
  queryAugmentationEnabled: boolean;
  queryAugmentationMaxEntities: number;
  queryAugmentationMinSimilarity: number;
  queryExpansionEnabled: boolean;
  queryExpansionMinSimilarity: number;
  repairConfidenceFloor: number;
  repairDeltaThreshold: number;
  repairLoopEnabled: boolean;
  repairLoopMinSimilarity: number;
  rerankSkipMinGap: number;
  rerankSkipTopSimilarity: number;
  retrievalProfileSettings: RetrievalProfile;
  similarityThreshold: number;
  temporalQueryConstraintBoost: number;
  temporalQueryConstraintEnabled: boolean;
  topicSearchEnabled: boolean;
  rerankerEnabled: boolean;
  rerankerTopN: number;
  recapSearchEnabled: boolean;
  counterEvidenceEnabled: boolean;
  packagingUseObservedAt: boolean;
  packagingDualDate: boolean;
  timelineChannelEnabled: boolean;
  answerOnlyRetrievalFilter: boolean;
  retrievalDedupEnabled: boolean;
  keywordRrfWeight: number;
  entityAttributesEnabled: boolean;
  entityAttributesTopK: number;
  userProfileChannelEnabled: boolean;
  episodesChannelEnabled: boolean;
  episodesChannelTopK: number;
  verifierPassEnabled: boolean;
  answerFormatAlignmentEnabled: boolean;
  eventChainPackagingEnabled: boolean;
  /** Reflect channel gate (BEAM-0.85 Phase 1, Task 1.9). */
  reflectEnabled: boolean;
  /** Top-K reflections to fetch when reflect retrieval is enabled. */
  reflectRetrievalTopK: number;
  /** Anthropic model used by the reflect worker. */
  reflectModel: string;
  /** Maximum observations the reflect worker persists per conversation. */
  reflectMaxObservations: number;
  /** Polling interval (ms) for the reflect background worker. */
  reflectJobPollMs: number;
  /** Debounce delay (ms) reserved for future worker throttling. */
  reflectDebounceMs: number;
  /**
   * Phase 2 specialists gate (BEAM-0.85 Phase 2). When true, the dispatcher
   * runs after top-K retrieval. First specialist with handled=true short-
   * circuits the shared spine. Default false.
   */
  phase2SpecialistsEnabled: boolean;
  /** LLM model ID (e.g. 'claude-haiku-4-5'). Used by specialist LLM calls. */
  llmModel: string;
  /** Master gate for all three abstention-rescue interventions. Default false. */
  abstentionRescueEnabled: boolean;
  /** Top-K for the iterative-retrieval rescue pass. Default 8. */
  abstentionRescueRetrieveK: number;
  /** Model used for the Sonnet rescue step. Default 'claude-sonnet-4-5'. */
  abstentionRescueSonnetModel: string;
  /**
   * Per-question-type adaptive confidence prefix (v36). When true, the forced
   * FORBIDDEN-abstention block only applies to SUMMARY/PREFERENCE/
   * NUMERIC_COUNT/EXACT_DATE; ORDERED_LIST/CONTRADICTION/OTHER get a soft
   * variant (rubric phrasing + KU temporal anchor, no FORBIDDEN block); ABSTAIN
   * passes through unchanged. Requires abstentionRescueEnabled=true.
   */
  confidencePrefixAdaptiveEnabled: boolean;
  /**
   * KU recency sort (v42). When true, NUMERIC_COUNT queries matching the
   * KU-style framing reorder packaged retrieval by observed_at DESC before
   * injection. See RuntimeConfig for full semantics. Default false.
   */
  kuRecencySortEnabled: boolean;
  /**
   * MSR cross-conversation aggregator (v39-multihop). When true, queries
   * classified as multi-session-reasoning (regex via `msr-detector.ts`) get
   * an extra `## CROSS-SESSION SUMMARY` channel inserted before the standard
   * OBSERVATIONS / TIMELINE / ENTITY_STATE blocks. See RuntimeConfig for
   * full semantics. Default false.
   */
  msrAggregatorEnabled: boolean;
  /**
   * Anthropic API key, threaded through CoreRuntimeConfig for Sonnet rescue.
   * Optional: only required when abstentionRescueEnabled is true and
   * llmProvider is not 'anthropic'.
   */
  anthropicApiKey?: string;
  /**
   * Always-on ENTITY_CARD channel gate (BEAM-0.85 — Honcho parity).
   * When true, the Reflect worker synthesizes per-entity summary cards and
   * the search pipeline injects them at the top of every answer-LLM prompt.
   */
  entityCardEnabled: boolean;
  /** Max entity cards synthesized per Reflect run. */
  entityCardMaxPerSession: number;
  /** Minimum observations an entity needs before its card is synthesized. */
  entityCardMinObservations: number;
  /** BEAM CR fix: bilateral preservation gate. See RuntimeConfig. */
  contradictionPreservationEnabled: boolean;
  /** BEAM CR fix: retrieval-side enrichment gate. See RuntimeConfig. */
  contradictionSurfacingEnabled: boolean;
  /**
   * BEAM v38: temporal state layer. When true, ingest classifies each new
   * memory with a stable `state_key` and supersedes prior memories with the
   * same key; CURRENT_STATE intent reranks active state above superseded.
   * Default false. See RuntimeConfig for full description.
   */
  temporalStateEnabled: boolean;
}

/** Repositories constructed by the runtime container. */
export interface CoreRuntimeRepos {
  memory: MemoryRepository;
  claims: ClaimRepository;
  trust: AgentTrustRepository;
  links: LinkRepository;
  entities: EntityRepository | null;
  lessons: LessonRepository | null;
  beliefEdges: BeliefEdgesRepository | null;
}

/** Services constructed on top of repositories. */
export interface CoreRuntimeServices {
  memory: MemoryService;
  /** Pointer-only document registry. */
  documents: DocumentService;
  /** Direct storage API service. */
  storage: StorageService;
}

export interface CoreRuntimeConfigRouteAdapter {
  base: () => RuntimeConfig;
  current: () => RuntimeConfigRouteSnapshot;
  update: (updates: RuntimeConfigUpdates) => string[];
}

/**
 * Explicit dependency bundle accepted by `createCoreRuntime`.
 *
 * `pool` is required — the composition root never reaches around to
 * import the singleton `pg.Pool` itself.
 *
 * Optional `config` is a composition-time override for isolated harnesses
 * such as AtomicBench. It is not a per-request override and should not be
 * used for multiple concurrently-active runtimes in one process while
 * singleton-importing leaf modules remain.
 */
export interface CoreRuntimeDeps {
  pool: pg.Pool;
  config?: RuntimeConfig;
}

/** The composed runtime — single source of truth for route registration. */
export interface CoreRuntime {
  config: RuntimeConfig;
  configRouteAdapter: CoreRuntimeConfigRouteAdapter;
  pool: pg.Pool;
  repos: CoreRuntimeRepos;
  /** Domain-facing store interfaces. Will replace repos once migration is complete. */
  stores: CoreStores;
  services: CoreRuntimeServices;
  /**
   * Active managed-blob adapter when `rawStorageMode='managed_blob'`;
   * `null` for pointer-only deployments. Exposed so the composition
   * root (`create-app.ts`) can read `capabilities` without re-running
   * the factory or reaching back through `services.documents`.
   * (Filecoin lifecycle refactor, Slice 4.)
   */
  rawContentStore: RawContentStore | null;
  /**
   * Per-row provider dispatch. Holds the active store plus
   * any legacy read-only adapters built from
   * `RAW_STORAGE_LEGACY_PROVIDERS`. Cleanup helpers use this to route
   * a DELETE to the right adapter for historical rows that pre-date a
   * provider switch.
   */
  storeRegistry: RawContentStoreRegistry;
  /**
   * Reconciler dependency bundle. Populated whenever the
   * deployment has `RAW_STORAGE_PROVIDER=filecoin` AND a configured
   * active Filecoin adapter; `null` otherwise. `null` is the signal
   * the production bootstrap reads to decide whether to call
   * `startReconciler`. `createCoreRuntime` does NOT start the
   * scheduler — tests stay deterministic by calling `runOnce(deps)`
   * directly.
   */
  reconcilerDeps: import('../services/raw-storage-reconciler.js').ReconcilerDeps | null;
}

/**
 * Compose the core runtime. Instantiates repositories and the memory
 * service from an explicit pool. Uses either the module-level config singleton
 * or an explicit composition-time config and passes that same object into leaf
 * module initializers and MemoryService so the composition root owns the seam.
 * No mutation.
 */
// fallow-ignore-next-line complexity
export async function createCoreRuntime(deps: CoreRuntimeDeps): Promise<CoreRuntime> {
  const { pool } = deps;
  const runtimeConfig = deps.config ?? defaultConfig;

  // Leaf-module config init. Embedding and LLM modules
  // hold module-local config bound here at composition-root time.
  // Provider/model selection is startup-only, so rebinding
  // only happens via explicit init call (e.g., from tests that swap
  // providers).
  initEmbedding(runtimeConfig);
  initLlm(runtimeConfig);

  // Raw-content adapter. Built up front so it can be threaded
  // into both the memory store layer (deleteAll honors managed-blob
  // cleanup) and the document service (upload + delete cascade). Null
  // for `rawStorageMode='pointer_only'` deployments. Async because the
  // Filecoin provider construction is async — the
  // plan's fail-closed rule requires credentials to be resolved at
  // composition time, not at first upload.
  const rawContentStore = await buildRawContentStore(runtimeConfig);
  // Per-row dispatch registry. Active store + any legacy
  // read-only adapters configured via `RAW_STORAGE_LEGACY_PROVIDERS`,
  // wrapped in one `RawContentStoreRegistry` that cleanup helpers
  // dispatch through.
  const legacyStores = buildLegacyStores(runtimeConfig);
  const storeRegistry = buildStoreRegistry(rawContentStore, legacyStores);
  // Content codec — wraps adapter `put()` so the bytes sent
  // to the provider may differ from the plaintext bytes the upload
  // service hashes. Plaintext content_hash/size_bytes stay the row's
  // source of truth; codec sidecar lands under raw_storage_metadata.codec.
  const rawContentCodec = buildRawContentCodec(runtimeConfig);
  const reconcilerDeps = buildReconcilerDeps(pool, rawContentStore, rawContentCodec, runtimeConfig);

  const memory = new MemoryRepository(pool, { rawContentStore, storeRegistry });
  const claims = new ClaimRepository(pool);
  const trust = new AgentTrustRepository(pool);
  const links = new LinkRepository(pool);
  const entities = runtimeConfig.entityGraphEnabled ? new EntityRepository(pool) : null;
  const lessons = runtimeConfig.lessonsEnabled ? new LessonRepository(pool) : null;
  const beliefEdges = runtimeConfig.tbcEnabled ? new BeliefEdgesRepository(pool) : null;
  const summaries = runtimeConfig.hierarchicalRetrievalEnabled ? new SummariesRepository(pool) : null;
  const userProfile = runtimeConfig.userProfileChannelEnabled ? new UserProfileRepository(pool) : null;
  const entityAttributes = runtimeConfig.entityAttributesEnabled ? new EntityAttributesRepository(pool) : null;
  const reflections = runtimeConfig.reflectEnabled ? new ReflectionsRepository(pool) : null;
  const reflectionJobs = runtimeConfig.reflectEnabled ? new ReflectionJobsRepository(pool) : null;
  const entityValues = runtimeConfig.phase2SpecialistsEnabled ? new EntityValuesRepository(pool) : null;
  const entityCards = runtimeConfig.entityCardEnabled ? new EntityCardsRepository(pool) : null;
  const contradictions = buildContradictionsRepo(runtimeConfig, pool);

  // TBC dual-write hook: when TBC is enabled, route belief operations
  // through BeliefEdgesRepository (typed edges) and a direct SQL update
  // on memories typed columns (confidence/belief_tier/mutation_type).
  // The hook is process-global (module-level singleton in tbc-execution).
  if (beliefEdges) {
    setBeliefDualWriteHook({
      async appendEdge(input) {
        await beliefEdges.appendEdge({
          userId: input.userId,
          sourceId: input.sourceId,
          targetId: input.targetId,
          edgeType: input.edgeType,
          weight: input.weight,
          rationale: input.rationale,
        });
      },
      async updateColumns(input) {
        const fields: string[] = [];
        const values: unknown[] = [];
        let i = 1;
        if (input.confidence !== undefined) { fields.push(`confidence = $${i++}`); values.push(input.confidence); }
        if (input.beliefTier !== undefined) { fields.push(`belief_tier = $${i++}`); values.push(input.beliefTier); }
        if (input.mutationType !== undefined) { fields.push(`mutation_type = $${i++}`); values.push(input.mutationType); }
        if (fields.length === 0) return;
        values.push(input.memoryId, input.userId);
        await pool.query(
          `UPDATE memories SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i}`,
          values,
        );
      },
    });
  } else {
    setBeliefDualWriteHook(undefined);
  }

  const stores: CoreStores = {
    memory: new PgMemoryStore(pool, { rawContentStore, storeRegistry }),
    episode: new PgEpisodeStore(pool),
    recap: new PgRecapStore(pool),
    search: new PgSearchStore(pool),
    link: new PgSemanticLinkStore(pool),
    representation: new PgRepresentationStore(pool),
    claim: claims,
    entity: entities,
    entityAttributes,
    lesson: lessons,
    summaries,
    userProfile,
    reflections,
    reflectionJobs,
    beliefEdges,
    entityValues,
    entityCards,
    contradictions,
    pool,
  };

  // TLL — per-entity event chain for EO/MSR/TR queries.
  // Append on memory store, traverse on retrieval.
  const tllRepository = entities ? new TllRepository(pool) : null;

  // First-mention events — chronological topic-introduction list. Caller
  // (e.g. an external harness) drives extraction explicitly via the
  // POST /v1/memories/first-mentions/extract route, supplying its own
  // turn-id-to-memory-id mapping (the ingest pipeline does not retain
  // turn structure). The chatFn adapter wraps the configured LLM
  // singleton; per-call cost is logged inside `llm.chat`.
  const firstMentionRepository = new FirstMentionRepository(pool);
  const firstMentionService = new FirstMentionService(
    firstMentionRepository,
    async (system, user, maxTokens) => {
      const text = await llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { maxTokens },
      );
      // Token usage is intentionally NOT returned here: `LLMProvider.chat`
      // emits per-call cost telemetry via `writeCostEvent` internally
      // (see `src/services/llm.ts`). Surfacing zeros at this seam invited
      // the bug the prior reviewer caught — readers would treat them as
      // real counts. Drop the field instead until usage is plumbed.
      return { text };
    },
  );

  // Document registry. Raw-content wiring provides a managed-blob
  // `RawContentStore` when `rawStorageMode='managed_blob'`; pointer-only
  // deployments get `null` here and the upload route returns 503. The
  // same store is threaded into MemoryService so reset-source can clean
  // up managed-blob URIs after the DB cascade.
  const service = new MemoryService(
    memory,
    claims,
    entities ?? undefined,
    lessons ?? undefined,
    undefined,
    runtimeConfig,
    stores,
    tllRepository ?? undefined,
    firstMentionService,
    rawContentStore,
    storeRegistry,
  );

  const documents = new DocumentService(pool, {
    rawContentStore,
    storeRegistry,
    codec: rawContentCodec,
    config: runtimeConfig,
  });

  // Direct storage API service. Each registered `RawContentStore`
  // (active + legacy) is wrapped in a `RawContentStoreBackendAdapter`
  // so the storage service can dispatch by `storage_artifacts.provider`
  // for read/delete/verify of historical rows whose provider differs
  // from the current active backend. Pointer artifacts short-circuit
  // before backend lookup so pointer-only deployments still work.
  const backendRegistry = buildBackendRegistry(
    rawContentStore === null ? null : new RawContentStoreBackendAdapter(rawContentStore),
    storeRegistry.entries
      .filter(([provider]) => provider !== rawContentStore?.provider)
      .map(([, store]) => new RawContentStoreBackendAdapter(store)),
  );
  const storage = new StorageService({
    pool,
    backendRegistry,
    pointerSchemes: runtimeConfig.rawStoragePointerUriSchemes,
    storageKeyHmacSecret: runtimeConfig.storageKeyHmacSecret,
  });

  // Start the reflect background worker when reflect is enabled.
  // The worker pulls pending reflection_jobs, runs the orchestrator,
  // and marks each job completed or failed. It is intentionally
  // fire-and-forget — the returned handle is not used here because the
  // process lifecycle owns shutdown (SIGTERM/SIGINT in server.ts).
  if (runtimeConfig.reflectEnabled && reflections && reflectionJobs) {
    const entityCardDeps = buildEntityCardDeps(runtimeConfig, entityCards);
    startReflectWorker(
      {
        jobs: reflectionJobs,
        runReflect: (userId: string, conversationId: string) =>
          runReflectForConversation(
            {
              fetchMemories: (u, c) => memory.findByConversation(u, c),
              llmCallTool: (system, user, schema) =>
                callAnthropicTool(runtimeConfig.reflectModel, system, user, schema as Parameters<typeof callAnthropicTool>[3]),
              embed: (text) => embedText(text),
              reflections,
              maxObservations: runtimeConfig.reflectMaxObservations,
              entityCards: entityCardDeps,
            },
            userId,
            conversationId,
          ),
      },
      runtimeConfig.reflectJobPollMs,
    );
  }

  return {
    config: runtimeConfig,
    configRouteAdapter: {
      base() {
        return runtimeConfig;
      },
      current() {
        return readRuntimeConfigRouteSnapshot(runtimeConfig);
      },
      update(updates) {
        return applyRuntimeConfigUpdates(runtimeConfig, updates);
      },
    },
    pool,
    repos: { memory, claims, trust, links, entities, lessons, beliefEdges },
    stores,
    services: { memory: service, documents, storage },
    rawContentStore,
    storeRegistry,
    reconcilerDeps,
  };
}

/**
 * Build the optional entity-card synthesis deps for the Reflect worker.
 * Returns `undefined` when the channel is disabled or the repo is null
 * — `runReflectForConversation` short-circuits on a missing/disabled bag.
 */
function buildEntityCardDeps(
  runtimeConfig: RuntimeConfig,
  entityCards: EntityCardsRepository | null,
): import('../services/reflect.js').ReflectEntityCardDeps | undefined {
  if (!entityCards || !runtimeConfig.entityCardEnabled) return undefined;
  return {
    enabled: true,
    repo: entityCards,
    synth: {
      llmCallTool: (system, user, schema) =>
        callAnthropicTool<{ card_text: string }>(
          runtimeConfig.reflectModel, system, user, schema,
        ),
      minObservations: runtimeConfig.entityCardMinObservations,
      maxEntities: runtimeConfig.entityCardMaxPerSession,
    },
    maxCardsPerSession: runtimeConfig.entityCardMaxPerSession,
  };
}

/**
 * BEAM CR fix: bilateral preservation. The repo is instantiated when either
 * the write-side preservation OR the read-side surfacing is enabled, since
 * retrieval enrichment needs to read pre-existing contradictions even when
 * the write-side flag has since been turned off. Extracted as a helper to
 * keep `createCoreRuntime` below the cyclomatic-complexity baseline.
 */
function buildContradictionsRepo(
  runtimeConfig: RuntimeConfig,
  pool: pg.Pool,
): ContradictionsRepository | null {
  const needsRepo =
    runtimeConfig.contradictionPreservationEnabled ||
    runtimeConfig.contradictionSurfacingEnabled;
  return needsRepo ? new ContradictionsRepository(pool) : null;
}

/**
 * Build the reconciler dependency bundle. Returns `null` until
 * production reconciler scheduling is enabled for the active provider.
 * The reconciler module remains in place so provider wiring can opt in
 * without changing the route layer.
 */
function buildReconcilerDeps(
  _pool: pg.Pool,
  _rawContentStore: RawContentStore | null,
  _codec: import('../storage/raw-content-codec.js').RawContentCodec,
  _cfg: RuntimeConfig,
): import('../services/raw-storage-reconciler.js').ReconcilerDeps | null {
  return null;
}
