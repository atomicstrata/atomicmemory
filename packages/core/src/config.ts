/**
 * Runtime configuration for the prototype backend.
 * Loads validated env-backed defaults, then allows limited in-memory updates
 * for local UI experimentation via PUT /v1/memories/config.
 */

import {
  getRetrievalProfile,
  parseRetrievalProfile,
  type RetrievalProfile,
  type RetrievalProfileName,
} from './services/retrieval-profiles.js';
import { parsePointerUriSchemes } from './storage/pointer-uri-allowlist.js';
import {
  collectFilecoinProviderEnvKeys,
  parseFilecoinProviderConfig,
  type FilecoinProviderConfig,
} from './storage/providers/filecoin/config.js';

export type EmbeddingProviderName = 'openai' | 'ollama' | 'openai-compatible' | 'transformers' | 'voyage';
export type LLMProviderName = EmbeddingProviderName | 'groq' | 'anthropic' | 'google-genai' | 'claude-code';
export type VectorBackendName = 'pgvector' | 'ruvector-mock' | 'zvec-mock';
export type CrossEncoderDtype = 'auto' | 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4' | 'q4f16';

/**
 * Phases 1 + 3 of the large-file ingestion plan ship `pointer_only`
 * and `managed_blob`. `inline_small_text` is reserved for a later
 * phase — `parseRawStorageMode` rejects it explicitly.
 */
export type RawStorageMode = 'pointer_only' | 'managed_blob';

/**
 * Content-codec selector that sits between the upload service and the
 * raw-content adapter. `none` is the pass-through (immediate providers'
 * default); `aes_gcm` wraps the bytes in AES-256-GCM ciphertext so the
 * adapter (and downstream content-addressing) only sees encrypted
 * bytes. The codec keyring (`RAW_CONTENT_CODEC_KEYS` +
 * `RAW_CONTENT_CODEC_ACTIVE_KEY_ID`) holds the rotation state.
 */
export type RawContentCodecName = 'none' | 'aes_gcm';

/**
 * Deployment-env classifier driving fail-closed policy decisions
 * (plaintext-Filecoin escape hatch, error `.cause` sanitization).
 * REQUIRED at startup; no `NODE_ENV` is read anywhere.
 */
export type RawStorageDeploymentEnv = 'production' | 'staging' | 'local';

export interface RuntimeConfig {
  databaseUrl: string;
  openaiApiKey: string;
  /**
   * Shared API key required on every authenticated `/v1/*` request.
   * Validated against `Authorization: Bearer <key>` by the
   * `requireBearer` middleware. REQUIRED at startup in every
   * environment; tests set it via `.env.test`. Operators rotate by
   * restarting the server with a new value.
   */
  coreApiKey: string;
  /**
   * Optional admin API key for test-scope cleanup endpoints. When unset,
   * admin routes are not mounted. Operators should use a different secret
   * from CORE_API_KEY so normal SDK callers cannot wipe scopes.
   */
  coreAdminApiKey?: string;
  /**
   * Explicit allow-pattern for admin cleanup scopes. Required alongside
   * CORE_ADMIN_API_KEY before the admin cleanup router is mounted; there is
   * no default so production deploys cannot accidentally enable wipes.
   */
  coreTestScopeAllowPattern?: string;
  /**
   * Hex-encoded secret used to derive per-user storage-key prefixes
   * via HMAC-SHA256. Storage keys take the form `s/<32hex>/<uuid>.bin`
   * where the 32 hex chars are the first 16 bytes of
   * `HMAC_SHA256(secret, userId)`. REQUIRED whenever managed-mode
   * storage is configured; pointer-only deployments still set it so
   * the config gate is one consistent contract. Must be at least 64
   * hex chars (32 bytes of entropy).
   */
  storageKeyHmacSecret: string;
  port: number;
  retrievalProfile: RetrievalProfileName;
  retrievalProfileSettings: RetrievalProfile;
  maxSearchResults: number;
  similarityThreshold: number;
  audnCandidateThreshold: number;
  audnSafeReuseMinSimilarity: number;
  crossAgentCandidateThreshold: number;
  clarificationConflictThreshold: number;
  adaptiveRetrievalEnabled: boolean;
  adaptiveSimpleLimit: number;
  adaptiveMediumLimit: number;
  adaptiveComplexLimit: number;
  adaptiveMultiHopLimit: number;
  adaptiveAggregationLimit: number;
  repairLoopEnabled: boolean;
  hybridSearchEnabled: boolean;
  repairLoopMinSimilarity: number;
  repairSkipSimilarity: number;
  mmrEnabled: boolean;
  mmrLambda: number;
  linkExpansionEnabled: boolean;
  linkExpansionMax: number;
  linkSimilarityThreshold: number;
  scoringWeightSimilarity: number;
  scoringWeightImportance: number;
  scoringWeightRecency: number;
  linkExpansionBeforeMMR: boolean;
  pprEnabled: boolean;
  pprDamping: number;
  repairDeltaThreshold: number;
  repairConfidenceFloor: number;
  embeddingProvider: EmbeddingProviderName;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  voyageApiKey?: string;
  voyageDocumentModel: string;
  voyageQueryModel: string;
  llmProvider: LLMProviderName;
  llmModel: string;
  llmApiUrl?: string;
  llmApiKey?: string;
  groqApiKey?: string;
  ollamaBaseUrl: string;
  vectorBackend: VectorBackendName;
  skipVectorIndexes: boolean;
  llmSeed?: number;
  stagedLoadingEnabled: boolean;
  retrievalTraceEnabled: boolean;
  ingestTraceDir: string;
  ingestTraceEnabled: boolean;
  extractionCacheEnabled: boolean;
  extractionCacheDir: string;
  embeddingCacheEnabled: boolean;
  chunkedExtractionEnabled: boolean;
  chunkedExtractionFallbackEnabled: boolean;
  chunkSizeTurns: number;
  chunkOverlapTurns: number;
  consensusExtractionEnabled: boolean;
  consensusExtractionRuns: number;
  observationDateExtractionEnabled: boolean;
  quotedEntityExtractionEnabled: boolean;
  entropyGateEnabled: boolean;
  entropyGateThreshold: number;
  entropyGateAlpha: number;
  affinityClusteringThreshold: number;
  affinityClusteringMinSize: number;
  affinityClusteringBeta: number;
  affinityClusteringTemporalLambda: number;
  trustScoringEnabled: boolean;
  trustScoreMinThreshold: number;
  trustPenaltyEnabled: boolean;
  auditLoggingEnabled: boolean;
  decayCycleEnabled: boolean;
  decayRetentionThreshold: number;
  decayMinAgeDays: number;
  memoryCapEnabled: boolean;
  memoryCapMax: number;
  memoryCapWarnRatio: number;
  entityGraphEnabled: boolean;
  entityResolutionThreshold: number;
  entitySearchMinSimilarity: number;
  lessonsEnabled: boolean;
  lessonSimilarityThreshold: number;
  consensusValidationEnabled: boolean;
  consensusMinMemories: number;
  queryExpansionEnabled: boolean;
  queryExpansionMinSimilarity: number;
  queryAugmentationEnabled: boolean;
  queryAugmentationMaxEntities: number;
  queryAugmentationMinSimilarity: number;
  crossEncoderEnabled: boolean;
  crossEncoderModel: string;
  crossEncoderDtype: CrossEncoderDtype;
  iterativeRetrievalEnabled: boolean;
  namespaceClassificationEnabled: boolean;
  fastAudnEnabled: boolean;
  fastAudnDuplicateThreshold: number;
  observationNetworkEnabled: boolean;
  agenticRetrievalEnabled: boolean;
  rerankSkipTopSimilarity: number;
  rerankSkipMinGap: number;
  literalListProtectionEnabled: boolean;
  literalListProtectionMaxProtected: number;
  temporalQueryConstraintEnabled: boolean;
  temporalQueryConstraintBoost: number;
  deferredAudnEnabled: boolean;
  deferredAudnBatchSize: number;
  compositeGroupingEnabled: boolean;
  compositeMinClusterSize: number;
  compositeMaxClusterSize: number;
  compositeSimilarityThreshold: number;
  anthropicApiKey?: string;
  googleApiKey?: string;
  costLoggingEnabled: boolean;
  costLogDir: string;
  costRunId: string;
  conflictAutoResolveMs: number;
  /**
   * Typed Belief Calculus (TBC) gate. When true, the AUDN decision step
   * defers to `decideBeliefOperator` from `services/typed-belief-calculus.ts`.
   * Default false — Phase 1 ships only the type surface and stub resolver,
   * so existing AUDN behavior is unchanged.
   */
  tbcEnabled: boolean;
  /**
   * Hierarchical retrieval (T2): adds a 5th RRF arm that searches over
   * conversation/session summaries first, then expands to atomic facts within
   * the matched sessions. Targets BEAM-10M scale (~14M tokens of context per
   * system) where flat top-K retrieval loses signal.
   * Default false.
   * Env var: HIERARCHICAL_RETRIEVAL_ENABLED=true
   */
  hierarchicalRetrievalEnabled: boolean;
  /**
   * Topic abstraction layer (Sprint 3 EO experiment): when true, ingest runs
   * a second LLM pass per chunk to extract a 3-7 word conceptual topic, embeds
   * it, and stores both alongside the raw fact. Retrieval fuses a topic-
   * embedding similarity stream into RRF when topicSearchEnabled is also true.
   * Default false. Design: benchmarks-sprint3/2026-05-10-am-baseline-and-rerank-design.md.
   * Env var: TOPIC_ABSTRACTION_ENABLED=true
   */
  topicAbstractionEnabled: boolean;
  /**
   * Topic search arm: when true (and topic_embedding column populated), the
   * search pipeline adds a topic-similarity RRF channel. Independent of the
   * ingest-side flag so the retrieval lift can be measured against pre-existing
   * topic-augmented memory state.
   * Default false. Env var: TOPIC_SEARCH_ENABLED=true
   */
  topicSearchEnabled: boolean;
  /**
   * Cross-encoder reranker: when true, the search pipeline reranks the top-N
   * RRF-fused candidates via an LLM-scored relevance pass. Adds ~50-150 ms
   * p95 retrieve latency. Mirrors Hindsight's reranking layer.
   * Default false. Env var: RERANKER_ENABLED=true
   */
  rerankerEnabled: boolean;
  /** Top-N candidates fed into the reranker (default 20). Env: RERANKER_TOP_N */
  rerankerTopN: number;
  /**
   * Recap layer (Sprint 3 v1, cross-session synthesis): when true, the
   * post-write pipeline opportunistically synthesizes Recaps from clusters
   * of memories sharing a topic_abstraction. Recaps are surfaced via their
   * own RRF channel at retrieval. Cog-sci analogue: hippocampal consolidation.
   * Requires topicAbstractionEnabled=true (clusters by topic field).
   * Default false. Env var: RECAP_LAYER_ENABLED=true
   */
  recapLayerEnabled: boolean;
  /** Min cluster size for recap building (default 4). Env: RECAP_MIN_CLUSTER_SIZE */
  recapMinClusterSize: number;
  /**
   * Recap cluster pivot (Sprint 3 v1.1 — V2 backlog #2).
   *   'topic'   — group by topic_abstraction (original; needs topic-abstraction
   *               layer ON; empirically regressed fact abilities).
   *   'session' — group by user_id + observed_at hour bucket (doesn't need
   *               topic-abstraction; captures cross-turn aggregation in a
   *               conversational window).
   * Default 'topic' to preserve existing behavior. Env: RECAP_CLUSTER_PIVOT
   */
  recapClusterPivot: 'topic' | 'session';
  /** When true, search pipeline adds a recap-similarity RRF channel.
   * Independent of layer flag so retrieval can be measured against pre-existing
   * recap state. Default false. Env: RECAP_SEARCH_ENABLED=true */
  recapSearchEnabled: boolean;
  /**
   * Counter-evidence retrieval (Sprint 3 v1.1 — V2 backlog item 1): when
   * true, the search pipeline expands the top-K result set with memories
   * that COUNTER any retrieved memory via the belief_edges graph. Surfaces
   * both sides of contradictions for CR-style queries.
   * Requires TBC to have been ON at ingest (populates belief_edges).
   * Default false. Env: COUNTER_EVIDENCE_ENABLED=true
   */
  counterEvidenceEnabled: boolean;
  /**
   * Temporal-aware packaging (Sprint 3 v1.2 — EO failure-mode fix).
   * When true, retrieval-format.ts surfaces `observed_at` (the
   * conversation timestamp captured during ingest) instead of
   * `created_at` (the ingest wall-clock) for:
   *   - chronological sort of the injection block
   *   - the per-memory date attribute
   *   - the Timeline summary
   * This restores within-conversation turn order for BEAM-style
   * backloaded ingestion where many turns share a single ingest time.
   * Default false (preserves existing behavior). Env:
   * PACKAGING_USE_OBSERVED_AT=true
   */
  packagingUseObservedAt: boolean;
  /**
   * Dual-date packaging (Sprint 3 v1.3 — companion to packagingUseObservedAt).
   * When true, retrieval-format.ts emits BOTH `created_at` and `observed_at`
   * attributes on every `<memory>` element when they differ. Lets the answer
   * LLM see ingest time AND conversation time and decide which to weight
   * per question, instead of forcing a global swap.
   * Independent of `packagingUseObservedAt` (which controls sort + label
   * date). Default false. Env: PACKAGING_DUAL_DATE=true
   */
  packagingDualDate: boolean;
  /**
   * Timeline channel (Sprint 3 v1.4 — H3 from haiku-080 master plan).
   * When true, retrieval-format.ts emits an additional `## TIMELINE`
   * section in the injection text. Dates are derived from observed_at
   * across the retrieved set, sorted ascending, deduplicated.
   * Independent of packagingUseObservedAt and packagingDualDate.
   * Default false. Env: TIMELINE_CHANNEL_ENABLED=true
   */
  timelineChannelEnabled: boolean;
  /**
   * Answer-only retrieval filter (Sprint 4 iter 1). When true, drop
   * advisory-only memories from the retrieved set before formatting the
   * injection. Insight: Sprint 3 incorrect-case analysis showed
   * retrieved contexts mixed verbose [context] snippets with specific
   * [answer] facts, and Haiku weighted the former over the latter.
   * Failsafe: if <3 memories survive the filter, falls back to the
   * unfiltered set. Default false. Env: ANSWER_ONLY_RETRIEVAL_FILTER=true
   */
  answerOnlyRetrievalFilter: boolean;
  /**
   * Near-duplicate dedup at retrieval (Sprint 4 iter 2). When true,
   * deduplicate retrieved memories by content fingerprint (lowercased
   * alphanumeric prefix of first 80 chars). Sprint 3 showed retrieved
   * contexts had same fact in 3-5 paraphrases per query; dedup makes
   * room for diverse memories.
   * Failsafe: if <3 memories survive, falls back to unfiltered set.
   * Default false. Env: RETRIEVAL_DEDUP_ENABLED=true
   */
  retrievalDedupEnabled: boolean;
  /**
   * BM25 keyword RRF weight (Sprint 4 iter 3). Default 1.0 (existing
   * behavior). Boosting to 1.5-2.0 prioritizes keyword/BM25 matches in
   * the hybrid RRF fan-in. Useful for queries that ask for specific
   * named facts ("how many X", "what is Y"). Only fires when
   * hybridSearchEnabled is true. Env: KEYWORD_RRF_WEIGHT=1.5
   */
  keywordRrfWeight: number;
  /**
   * Entity-Attribute Index (EAI — Sprint 4). When true, ingest extracts
   * (entity, attribute, value) triples into the `entity_attributes` table
   * and retrieval queries that table for fact-specific lookups (e.g.
   * "how many columns did I add?", "what's the API quota?"). Storage
   * foundation lands first; extraction (Task B) and retrieval (Task C)
   * activate the channel.
   * Default false. Env var: ENTITY_ATTRIBUTES_ENABLED=true
   */
  entityAttributesEnabled: boolean;
  /**
   * Top-K EAI rows to fetch when the entity-attributes channel is enabled
   * (Sprint 4 — Task C). Clamped to [5, 40] inside `fetchEntityFactsForInjection`
   * — too few drops near-misses, too many bloats the `## FACTS` block.
   * Default 20. Env: ENTITY_ATTRIBUTES_TOP_K=20
   */
  entityAttributesTopK: number;
  /**
   * User-profile channel (Sprint 3 v1.5 — H2 from haiku-080 master plan).
   * When true, post-write synthesizes a per-user profile document
   * (Honcho-style) after each ingest that stores >= 3 new memories.
   * The search pipeline prepends the profile as a `## USER PROFILE`
   * block at the head of every answer prompt.
   * Default false. Env: USER_PROFILE_CHANNEL_ENABLED=true
   */
  userProfileChannelEnabled: boolean;
  /**
   * Episodes-as-separate-channel (Sprint 3 v1.6 — H4 from haiku-080 master
   * plan). When true, the search pipeline fetches the top-K recap rows for
   * the query embedding via `RecapStore.findRecapCandidates` and threads
   * them through the injection builder as a dedicated `## EPISODES` block,
   * INSTEAD OF routing recaps through the RRF fan-in. Sprint 3 v1.1
   * documented that the RRF route displaced 3-5 atomic facts per recap in
   * top-K and regressed fact-anchored abilities; this flag lets recap
   * narrative surface to the answer LLM without paying that displacement
   * cost. Independent of `recapSearchEnabled` (recap-via-RRF) — typical
   * config has the layer ON, recap-search OFF, and episodes-channel ON.
   * Default false. Env: EPISODES_CHANNEL_ENABLED=true
   */
  episodesChannelEnabled: boolean;
  /**
   * Top-K recap rows to fetch when the episodes channel is enabled.
   * Default 2. Clamped to [1, 5] inside memory-search to bound prompt
   * growth — large K dilutes the channel signal without lifting recall.
   * Env: EPISODES_CHANNEL_TOP_K=2
   */
  episodesChannelTopK: number;
  /**
   * Verifier pass (Sprint 3 v1.7 — H5 from haiku-080 master plan).
   * Informational flag from AM core's perspective — the AMB adapter
   * inspects `ATOMICMEMORY_VERIFIER_ENABLED` to decide whether to call
   * `/v1/memories/verify` between its answer-LLM call and scoring. The
   * flag is surfaced in core config for symmetry with the other channel
   * flags so iteration env files can request the verifier pass.
   * Default false. Env: VERIFIER_PASS_ENABLED=true
   */
  verifierPassEnabled: boolean;
  /**
   * Layer 1 answer-format alignment (BEAM-0.85 Phase 0): when true,
   * `buildInjection` prepends a per-question-type FORMAT hint to the
   * injection prompt so the answer LLM produces structured output that
   * matches the query shape (e.g. ordered lists, yes/no, prose).
   * Default false. Env: ANSWER_FORMAT_ALIGNMENT_ENABLED=true
   */
  answerFormatAlignmentEnabled: boolean;
  /**
   * Event-chain packaging (EO fix — data-driven detector). When true,
   * `buildInjection` prepends a `## EVENT_CHAIN` block listing the
   * chronological chain with the highest score detected in the retrieved
   * top-K. The detector fires regardless of query phrasing — it inspects
   * the retrieved data for 3+ memories sharing an entity across 3+ distinct
   * observed_at dates. Default false (ships behind flag for incremental
   * validation). Env: EVENT_CHAIN_PACKAGING_ENABLED=true
   */
  eventChainPackagingEnabled: boolean;
  /**
   * Reflect channel — query-time reflection retrieval (BEAM-0.85 Phase 1,
   * Task 1.9). When true, after RRF + reranking produce the selected memories,
   * the search pipeline also embeds the query and fetches top-K reflections
   * from session_reflections. The result is threaded downstream to
   * retrieval-format as a parallel signal alongside chainResult.
   * Gated by question type (SUMMARY, CONTRADICTION, PREFERENCE, NUMERIC_COUNT,
   * EXACT_DATE, ORDERED_LIST — see reflect-retrieval.ts ROUTED_TYPES).
   * Default false. Env: REFLECT_ENABLED=true
   */
  reflectEnabled: boolean;
  /**
   * Top-K reflections to fetch when reflect retrieval is enabled.
   * Default 3. Env: REFLECT_RETRIEVAL_TOP_K=3
   */
  reflectRetrievalTopK: number;
  /**
   * Anthropic model used by the reflect worker for observation generation.
   * Default 'claude-sonnet-4-5'. Env: REFLECT_MODEL=<model-id>
   */
  reflectModel: string;
  /**
   * Maximum observations per conversation the reflect worker will persist.
   * Default 12. Env: REFLECT_MAX_OBSERVATIONS=12
   */
  reflectMaxObservations: number;
  /**
   * Polling interval (ms) for the reflect background worker.
   * Default 5000. Env: REFLECT_JOB_POLL_MS=5000
   */
  reflectJobPollMs: number;
  /**
   * Debounce delay (ms) before a reflect job becomes eligible for processing.
   * Not enforced in v1 worker but reserved for future use.
   * Default 60000. Env: REFLECT_DEBOUNCE_MS=60000
   */
  reflectDebounceMs: number;
  /**
   * Dev/test-only: when true, PUT /v1/memories/config mutates the runtime
   * singleton. Production deploys leave this unset (false) — the route
   * returns 410 Gone. Startup-validated; routes read the memoized value
   * through configRouteAdapter, never re-check at request time.
   */
  runtimeConfigMutationEnabled: boolean;
  /**
   * Phase 2 specialists gate (BEAM-0.85 Phase 2). When true, the specialist
   * dispatcher runs after RRF + reranking produce top-K memories. The first
   * specialist that matches the query pattern AND returns handled=true
   * short-circuits the shared spine — its answer replaces the LLM output.
   * Ingest-side: extractLiteralsFromFact runs fire-and-forget per new
   * memory to populate entity_values for the IE/KU SQL lookup.
   * Priority: CR → TR → MSR → IE/KU → shared spine.
   * Default false. Env: PHASE2_SPECIALISTS_ENABLED=true
   */
  phase2SpecialistsEnabled: boolean;
  /**
   * Master gate for all three abstention-rescue interventions.
   * Compensates for Haiku over-abstention: the model writes answers like
   * "context does not contain information (March 10, 2024)" — citing the
   * answer while claiming not to find it.
   * Interventions (all gated here):
   *   1. Confidence prefix — prepended to injectionText on every call.
   *   2. Iterative retrieval — second retrieval pass with extracted keywords
   *      when the first answer abstains and retrieval was non-empty.
   *   3. Sonnet rescue — retry with Sonnet if Haiku still abstains.
   * Default false. Env: ABSTENTION_RESCUE_ENABLED=true
   */
  abstentionRescueEnabled: boolean;
  /** Top-K for the iterative-retrieval rescue pass. Default 8. Env: ABSTENTION_RESCUE_RETRIEVE_K */
  abstentionRescueRetrieveK: number;
  /** Model used for the Sonnet rescue step. Default 'claude-sonnet-4-5'. Env: ABSTENTION_RESCUE_SONNET_MODEL */
  abstentionRescueSonnetModel: string;
  /**
   * Per-question-type adaptive confidence prefix (v36). When true, the forced
   * FORBIDDEN-abstention prefix only applies to SUMMARY/PREFERENCE/
   * NUMERIC_COUNT/EXACT_DATE (where v34 showed +0.09 to +0.27 lifts); a soft
   * prefix (rubric phrasing + KU temporal anchor, no FORBIDDEN block) applies
   * to ORDERED_LIST/CONTRADICTION/OTHER (where v34 regressed −0.13 to −0.22
   * by fabricating); ABSTAIN passes through unchanged. Requires
   * `abstentionRescueEnabled=true`. Default false. Env:
   * CONFIDENCE_PREFIX_ADAPTIVE_ENABLED=true
   */
  confidencePrefixAdaptiveEnabled: boolean;
  /**
   * KU recency sort (v42). When true, NUMERIC_COUNT queries that ALSO match
   * the KU-style framing pattern (isKuStyleQuery) reorder packaged retrieval
   * by observed_at DESC before injection — so the answer LLM sees the most
   * recent measurement first. Targets BEAM KU Mode B (wrong-value-forced)
   * where Haiku picks the earlier of two competing values. Default false.
   * Env: KU_RECENCY_SORT_ENABLED=true
   */
  kuRecencySortEnabled: boolean;
  /**
   * MSR cross-conversation aggregator (v39-multihop). When true, queries
   * classified as multi-session-reasoning (regex via `msr-detector.ts`) get
   * an extra `## CROSS-SESSION SUMMARY` channel inserted before the standard
   * OBSERVATIONS / TIMELINE / ENTITY_STATE blocks. Retrieved memories are
   * grouped by `episode_id`; groups with >=2 memories are summarized via the
   * configured chat LLM (default Haiku, ~30 tokens each); 1-memory groups
   * pass through verbatim. Targets BEAM MSR (v36: 0.156/0.172) where gold
   * facts span 2-4 conversations and the answer LLM cannot synthesize across
   * them. Fail-closed on summary errors. Default false. Env:
   * MSR_AGGREGATOR_ENABLED=true
   */
  msrAggregatorEnabled: boolean;
  /**
   * Always-on ENTITY_CARD channel (BEAM-0.85 — Honcho parity). When true,
   * the Reflect worker synthesizes per-entity summary cards alongside the
   * existing observations, and the search pipeline injects all cards for
   * the active conversation under `## ENTITY_STATE` at the top of every
   * answer-LLM prompt. Default false. Env: ENTITY_CARD_ENABLED=true
   */
  entityCardEnabled: boolean;
  /** Max entity cards synthesized per Reflect run. Default 5. Env: ENTITY_CARD_MAX_PER_SESSION */
  entityCardMaxPerSession: number;
  /**
   * Minimum observations an entity needs in a Reflect run before its card
   * is synthesized. Default 3. Env: ENTITY_CARD_MIN_OBSERVATIONS
   */
  entityCardMinObservations: number;
  /**
   * AUDN bilateral preservation for contradictions (BEAM CR fix). When true,
   * AUDN's DELETE and SUPERSEDE outcomes are replaced by a bilateral path
   * that keeps BOTH the prior memory and the new memory in `memories`,
   * marks both with `contradiction_active=true` and bidirectional
   * `contradicts_memory_id`, and records the pair in
   * `memory_contradictions`. Targets the BEAM `contradiction_resolution`
   * rubric, which requires the answer to quote BOTH sides verbatim.
   * Default false. Env: CONTRADICTION_PRESERVATION_ENABLED=true
   */
  contradictionPreservationEnabled: boolean;
  /**
   * Retrieval-side surfacing of contradictions (BEAM CR fix). When true,
   * after top-K assembly the search pipeline enriches the result set:
   *   - any memory in top-K with `contradiction_active=true` has its
   *     counterpart (`contradicts_memory_id`) injected into the final set,
   *   - a `## CONTRADICTIONS_DETECTED` section listing both sides verbatim
   *     is prepended to the injection text.
   * Independent of `contradictionPreservationEnabled` so the retrieval
   * lift can be measured against pre-existing contradiction state.
   * Default false. Env: CONTRADICTION_SURFACING_ENABLED=true
   */
  contradictionSurfacingEnabled: boolean;
  /**
   * BEAM v38: temporal state layer (focused Mem0 temporal-reasoning subset).
   * When true:
   *   - At ingest, an LLM classifier tags each stored memory with a stable
   *     `state_key` for stateful facts (e.g. "user lives in Austin"); newly
   *     stored stateful memories supersede prior memories with the same key
   *     by setting their `event_end` to the new `event_start`.
   *   - At read, a regex-based intent classifier flags CURRENT_STATE
   *     queries; the retrieval pipeline reranks candidates so memories with
   *     active state (`event_end IS NULL`) outrank superseded ones.
   * Targets the KU rubric (currently 0.25). Fail-closed: supersede UPDATE
   * failures abort the ingest. Default false. Env: TEMPORAL_STATE_ENABLED=true
   */
  temporalStateEnabled: boolean;
  /**
   * Document raw-content retention mode. `pointer_only` registers
   * external references; `managed_blob` stores bytes through the
   * configured raw-storage provider. `inline_small_text` is reserved.
   */
  rawStorageMode: RawStorageMode;
  /**
   * Adapter behind `rawStorageMode = 'managed_blob'`. NULL for the
   * pointer-only path; required at startup when `rawStorageMode =
   * 'managed_blob'`. No fallback — misconfigured setups fail closed.
   */
  rawStorageProvider: RawStorageProvider | null;
  /** Optional global path prefix (e.g. `prod/core`) applied to every key. */
  rawStoragePrefix: string;
  /** Provider-specific options. Always populated, validated at startup. */
  rawStorageLocalFsRoot: string | null;
  rawStorageS3Bucket: string | null;
  rawStorageS3Region: string | null;
  rawStorageS3Endpoint: string | null;
  rawStorageS3AccessKeyId: string | null;
  rawStorageS3SecretAccessKey: string | null;
  /** Per-request upload size cap for `PUT /v1/documents/:id/raw`. */
  rawUploadMaxBytes: number;
  /** Content codec applied between the upload service and the raw-content adapter. */
  rawContentCodec: RawContentCodecName;
  /**
   * Parsed keyring entries keyed by operator-assigned id. Required and
   * non-empty when `rawContentCodec='aes_gcm'`. Each value is a 32-byte
   * key. Keys are kept in the ring so old rows stay decodable after
   * rotation; new writes use `rawContentCodecActiveKeyId`.
   */
  rawContentCodecKeys: ReadonlyMap<string, Buffer>;
  /** Key id chosen for NEW encode operations. Must reference an entry in the ring. */
  rawContentCodecActiveKeyId: string | null;
  /** Required at startup; drives fail-closed policy in cross-validation. */
  rawStorageDeploymentEnv: RawStorageDeploymentEnv;
  /**
   * Parsed Synapse-shaped Filecoin provider config. Populated only
   * when `rawStorageProvider === 'filecoin'`; `null` otherwise. The
   * cross-provider guard in `validateRawStorageConfig` rejects any
   * `RAW_STORAGE_FILECOIN_*` env var on non-filecoin deployments
   * before this field is computed, so the operator cannot leave
   * stale Filecoin knobs lying around.
   */
  filecoinProvider: FilecoinProviderConfig | null;
  /**
   * CSV of legacy providers kept registered as read-only stores so the
   * cleanup-time registry can dispatch DELETEs against historical rows
   * after the active provider has been switched. Validated for env-block
   * completeness at startup. Never contains the active provider.
   */
  rawStorageLegacyProviders: ReadonlyArray<RawStorageProvider>;
  /**
   * Closed allowlist of pointer-mode URI schemes the direct storage
   * API accepts. Defaults to the safe set `https://, s3://, gs://,
   * ipfs://`. Operators can opt in `http://` and `local-fs://` via
   * `RAW_STORAGE_POINTER_URI_SCHEMES` (csv). Unknown tokens fail
   * closed at startup. The server NEVER fetches pointer URIs — this
   * is downstream-consumer hygiene, not SSRF defence.
   */
  rawStoragePointerUriSchemes: ReadonlyArray<PointerUriScheme>;
}

/** Closed set of pointer-mode URI schemes operators can allowlist. */
export type PointerUriScheme = 'https' | 's3' | 'gs' | 'ipfs' | 'http' | 'local-fs';

/** Production providers backing `rawStorageMode='managed_blob'`. */
export type RawStorageProvider = 'local_fs' | 's3' | 'filecoin';

/**
 * Fields accepted by `updateRuntimeConfig()`. Provider/model selection
 * (embeddingProvider, embeddingModel, voyage*, llmProvider, llmModel) is
 * intentionally absent: embedding.ts and llm.ts cache stateful provider
 * instances at first call, so mid-flight mutation never took effect in v1.
 * Freezing these as composition-time config is a bug fix. Server deployments
 * still use env-backed startup config; isolated harnesses can pass an explicit
 * RuntimeConfig to createCoreRuntime({ config }).
 */
export interface RuntimeConfigUpdates {
  similarityThreshold?: number;
  audnCandidateThreshold?: number;
  clarificationConflictThreshold?: number;
  maxSearchResults?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function parseEmbeddingProvider(
  value: string | undefined,
  fallback: EmbeddingProviderName,
): EmbeddingProviderName {
  if (!value) return fallback;
  const valid: EmbeddingProviderName[] = ['openai', 'ollama', 'openai-compatible', 'transformers', 'voyage'];
  if (!valid.includes(value as EmbeddingProviderName)) {
    throw new Error(`Invalid provider "${value}". Must be one of: ${valid.join(', ')}`);
  }
  return value as EmbeddingProviderName;
}

function parseLlmProvider(value: string | undefined, fallback: LLMProviderName): LLMProviderName {
  if (!value) return fallback;
  const valid: LLMProviderName[] = [
    'openai',
    'ollama',
    'openai-compatible',
    'groq',
    'anthropic',
    'google-genai',
    'claude-code',
  ];
  if (!valid.includes(value as LLMProviderName)) {
    throw new Error(`Invalid provider "${value}". Must be one of: ${valid.join(', ')}`);
  }
  return value as LLMProviderName;
}

function defaultLlmModel(provider: LLMProviderName): string {
  if (provider === 'claude-code') return '';
  return 'gpt-4o-mini';
}


function requireFiniteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function parseCrossEncoderDtype(value: string | undefined): CrossEncoderDtype {
  const dtype = value ?? 'auto';
  const valid: CrossEncoderDtype[] = ['auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16'];
  if (!valid.includes(dtype as CrossEncoderDtype)) {
    throw new Error(`Invalid CROSS_ENCODER_DTYPE "${dtype}". Must be one of: ${valid.join(', ')}`);
  }
  return dtype as CrossEncoderDtype;
}

function parseLlmSeed(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRegexEnv(name: string): string | undefined {
  const raw = optionalEnv(name);
  if (!raw) return undefined;
  try {
    new RegExp(raw);
    return raw;
  } catch {
    throw new Error(`${name} must be a valid JavaScript regular expression`);
  }
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseVectorBackend(value: string | undefined): VectorBackendName {
  if (!value) return 'pgvector';
  if (value === 'pgvector' || value === 'ruvector-mock' || value === 'zvec-mock') return value;
  throw new Error('Invalid VECTOR_BACKEND. Must be "pgvector", "ruvector-mock", or "zvec-mock"');
}

/**
 * Phases 1 + 3 of the large-file ingestion plan accept `pointer_only`
 * and `managed_blob` respectively. `inline_small_text` is reserved for
 * a later phase — fail closed rather than silently downgrading if an
 * operator sets it now.
 */
function parseRawStorageMode(value: string | undefined): RawStorageMode {
  if (!value || value === 'pointer_only') return 'pointer_only';
  if (value === 'managed_blob') return 'managed_blob';
  if (value === 'inline_small_text') {
    throw new Error(
      "RAW_STORAGE_MODE='inline_small_text' is not yet supported. Use " +
        "'pointer_only' or 'managed_blob'.",
    );
  }
  throw new Error(`Invalid RAW_STORAGE_MODE '${value}'. Must be 'pointer_only' or 'managed_blob'.`);
}

/** Parse + validate RAW_STORAGE_PROVIDER for `managed_blob` mode. */
function parseRawStorageProvider(value: string | undefined): RawStorageProvider | null {
  if (!value) return null;
  if (value === 'local_fs' || value === 's3' || value === 'filecoin') return value;
  throw new Error(
    `Invalid RAW_STORAGE_PROVIDER '${value}'. Must be 'local_fs', 's3', or 'filecoin'.`,
  );
}

/** Parse `RAW_CONTENT_CODEC` env var. Defaults to `'none'`. */
function parseRawContentCodec(value: string | undefined): RawContentCodecName {
  if (!value) return 'none';
  if (value === 'none' || value === 'aes_gcm') return value;
  throw new Error(`Invalid RAW_CONTENT_CODEC '${value}'. Must be 'none' or 'aes_gcm'.`);
}

/**
 * Parse `RAW_CONTENT_CODEC_KEYS` env var: comma-separated `keyId:base64Url`
 * pairs. Each decoded key MUST be exactly 32 bytes (AES-256). Empty
 * input returns an empty ring (validation runs separately).
 */
function parseRawContentCodecKeys(value: string | undefined): ReadonlyMap<string, Buffer> {
  const ring = new Map<string, Buffer>();
  if (!value) return ring;
  const entries = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon <= 0) {
      throw new Error(
        `RAW_CONTENT_CODEC_KEYS entry '${entry}' must be '<keyId>:<base64Url-32B>'.`,
      );
    }
    const keyId = entry.slice(0, colon);
    const encoded = entry.slice(colon + 1);
    let key: Buffer;
    try {
      key = Buffer.from(encoded, 'base64url');
    } catch {
      throw new Error(`RAW_CONTENT_CODEC_KEYS entry for '${keyId}' is not valid base64url.`);
    }
    if (key.length !== 32) {
      throw new Error(
        `RAW_CONTENT_CODEC_KEYS entry for '${keyId}' decoded to ${key.length} bytes; expected 32.`,
      );
    }
    if (ring.has(keyId)) {
      throw new Error(`Duplicate keyId '${keyId}' in RAW_CONTENT_CODEC_KEYS.`);
    }
    ring.set(keyId, key);
  }
  return ring;
}

/** Parse the required `RAW_STORAGE_DEPLOYMENT_ENV` knob. */
function parseRawStorageDeploymentEnv(value: string | undefined): RawStorageDeploymentEnv {
  if (!value) {
    throw new Error(
      "RAW_STORAGE_DEPLOYMENT_ENV is required. Set 'production', 'staging', or 'local'.",
    );
  }
  if (value === 'production' || value === 'staging' || value === 'local') return value;
  throw new Error(
    `Invalid RAW_STORAGE_DEPLOYMENT_ENV '${value}'. Must be 'production', 'staging', or 'local'.`,
  );
}

/**
 * Parse `RAW_STORAGE_LEGACY_PROVIDERS` (csv). The active provider is
 * NEVER allowed in this list — that check happens in
 * `validateRawStorageConfig` since it requires knowing which provider
 * is active. Unknown values fail closed here so typos surface.
 */
function parseLegacyProviders(value: string | undefined): ReadonlyArray<RawStorageProvider> {
  if (!value) return [];
  const entries = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out: RawStorageProvider[] = [];
  const seen = new Set<RawStorageProvider>();
  for (const entry of entries) {
    if (entry !== 'local_fs' && entry !== 's3' && entry !== 'filecoin') {
      throw new Error(
        `Invalid RAW_STORAGE_LEGACY_PROVIDERS entry '${entry}'. ` +
          "Each item must be 'local_fs', 's3', or 'filecoin'.",
      );
    }
    if (seen.has(entry)) {
      throw new Error(`Duplicate provider '${entry}' in RAW_STORAGE_LEGACY_PROVIDERS.`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Cross-field guard for the raw-storage knobs. Runs once at startup and
 * fails closed when `managed_blob` is enabled without the provider
 * fields the chosen adapter needs. No default values, no fallback
 * provider — misconfiguration must surface deterministically per the
 * Phase-3 plan.
 */
export interface RawStorageValidationInput {
  mode: RawStorageMode;
  provider: RawStorageProvider | null;
  prefix: string;
  localFsRoot: string | null;
  s3Bucket: string | null;
  s3Region: string | null;
  s3AccessKeyId: string | null;
  s3SecretAccessKey: string | null;
  codec: RawContentCodecName;
  codecKeys: ReadonlyMap<string, Buffer>;
  codecActiveKeyId: string | null;
  deploymentEnv: RawStorageDeploymentEnv;
  legacyProviders: ReadonlyArray<RawStorageProvider>;
  /**
   * Names of `RAW_STORAGE_FILECOIN_*` env vars the operator set to a
   * non-empty value, computed by
   * `collectFilecoinProviderEnvKeys(process.env)` in `src/config.ts`.
   * The cross-provider guard in `validateRawStorageConfig` rejects
   * any non-empty list when `provider !== 'filecoin'`. Tests pass a
   * fixed array directly.
   */
  filecoinEnvKeysSet: ReadonlyArray<string>;
}

/**
 * Phase-3 plan requires every managed blob to live under a namespaced
 * path including environment, user, and document ids. The user/doc
 * portion is generated per-upload; the environment portion is the
 * `RAW_STORAGE_PREFIX` operator-supplied namespace. Validate that the
 * prefix is a non-empty *relative* path with no `..` segments before
 * it gets joined with caller-controlled key fragments.
 */
function validateRawStoragePrefix(prefix: string): void {
  if (!prefix || prefix.trim().length === 0) {
    throw new Error(
      "RAW_STORAGE_MODE='managed_blob' requires RAW_STORAGE_PREFIX " +
        '(a relative namespace path, e.g. `prod/core`).',
    );
  }
  if (prefix.startsWith('/')) {
    throw new Error("RAW_STORAGE_PREFIX must be a relative path (no leading '/').");
  }
  const segments = prefix.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    throw new Error("RAW_STORAGE_PREFIX must not contain '..' segments.");
  }
}

function validateFilecoinCodecPolicy(args: RawStorageValidationInput): void {
  if (args.provider !== 'filecoin') return;
  if (args.codec === 'aes_gcm') return;
  if (args.deploymentEnv === 'local') return;
  throw new Error(
    "RAW_STORAGE_PROVIDER='filecoin' requires RAW_CONTENT_CODEC='aes_gcm' " +
      "when RAW_STORAGE_DEPLOYMENT_ENV is 'production' or 'staging'. " +
      "Plaintext Filecoin storage is only allowed for local development.",
  );
}

export function validateRawStorageConfig(args: RawStorageValidationInput): void {
  validateCodecConfig(args);
  validateLegacyProviders(args);
  rejectFilecoinEnvOnNonFilecoinProvider(args);
  if (args.mode !== 'managed_blob') {
    if (args.provider !== null) {
      throw new Error(
        "RAW_STORAGE_PROVIDER is set but RAW_STORAGE_MODE is not 'managed_blob'. " +
          "Either set RAW_STORAGE_MODE='managed_blob' or unset RAW_STORAGE_PROVIDER.",
      );
    }
    return;
  }
  if (!args.provider) {
    throw new Error(
      "RAW_STORAGE_MODE='managed_blob' requires RAW_STORAGE_PROVIDER " +
        "('local_fs', 's3', or 'filecoin').",
    );
  }
  validateRawStoragePrefix(args.prefix);
  if (args.provider === 'local_fs') {
    if (!args.localFsRoot) {
      throw new Error("RAW_STORAGE_PROVIDER='local_fs' requires RAW_STORAGE_LOCAL_FS_ROOT.");
    }
    return;
  }
  if (args.provider === 's3') {
    const missing = collectMissingS3Fields(args);
    if (missing.length > 0) {
      throw new Error(`RAW_STORAGE_PROVIDER='s3' requires: ${missing.join(', ')}.`);
    }
    return;
  }
  validateFilecoinCodecPolicy(args);
  // provider === 'filecoin'. Synapse-shaped env validation lives in
  // `parseFilecoinProviderConfig` (called from this file's config
  // init block below) so the provider module is the single source
  // of truth for its own field shape. The cross-provider guard fires
  // BEFORE this branch so a misconfigured non-filecoin deployment
  // carrying stray Filecoin vars fails fast.
}

/**
 * Reject any `RAW_STORAGE_FILECOIN_*` environment variable that is
 * set when `RAW_STORAGE_PROVIDER` is not `'filecoin'`. The provider
 * module's parser is only invoked on the filecoin branch, so this
 * central guard is the only seam that catches "operator left stale
 * Filecoin config on an S3 deployment" misconfigurations.
 */
function rejectFilecoinEnvOnNonFilecoinProvider(args: RawStorageValidationInput): void {
  if (args.provider === 'filecoin') return;
  if (args.filecoinEnvKeysSet.length === 0) return;
  throw new Error(
    `RAW_STORAGE_FILECOIN_* environment variables are set but ` +
      `RAW_STORAGE_PROVIDER='${args.provider ?? '<unset>'}'. ` +
      `Filecoin provider configuration is only valid when ` +
      `RAW_STORAGE_PROVIDER=filecoin. Unset: ${args.filecoinEnvKeysSet.join(', ')}.`,
  );
}

function collectMissingS3Fields(args: RawStorageValidationInput): string[] {
  return [
    !args.s3Bucket && 'RAW_STORAGE_S3_BUCKET',
    !args.s3Region && 'RAW_STORAGE_S3_REGION',
    !args.s3AccessKeyId && 'RAW_STORAGE_S3_ACCESS_KEY_ID',
    !args.s3SecretAccessKey && 'RAW_STORAGE_S3_SECRET_ACCESS_KEY',
  ].filter((x): x is string => Boolean(x));
}

function collectMissingLocalFsFields(args: RawStorageValidationInput): string[] {
  return args.localFsRoot ? [] : ['RAW_STORAGE_LOCAL_FS_ROOT'];
}

/**
 * Codec-level validation independent of the active provider: if the
 * operator selected `aes_gcm`, they MUST configure a non-empty keyring
 * and an active key id present in that ring. Misconfiguration fails
 * closed at startup rather than at first encode.
 */
function validateCodecConfig(args: RawStorageValidationInput): void {
  if (args.codec !== 'aes_gcm') {
    if (args.codecKeys.size > 0 || args.codecActiveKeyId !== null) {
      throw new Error(
        "RAW_CONTENT_CODEC is not 'aes_gcm' but codec keyring fields are set. " +
          "Either set RAW_CONTENT_CODEC='aes_gcm' or unset RAW_CONTENT_CODEC_KEYS/_ACTIVE_KEY_ID.",
      );
    }
    return;
  }
  if (args.codecKeys.size === 0) {
    throw new Error("RAW_CONTENT_CODEC='aes_gcm' requires RAW_CONTENT_CODEC_KEYS (non-empty).");
  }
  if (!args.codecActiveKeyId) {
    throw new Error("RAW_CONTENT_CODEC='aes_gcm' requires RAW_CONTENT_CODEC_ACTIVE_KEY_ID.");
  }
  if (!args.codecKeys.has(args.codecActiveKeyId)) {
    throw new Error(
      `RAW_CONTENT_CODEC_ACTIVE_KEY_ID='${args.codecActiveKeyId}' is not present in RAW_CONTENT_CODEC_KEYS.`,
    );
  }
}

/**
 * `RAW_STORAGE_LEGACY_PROVIDERS` validation: every named provider must
 * have its full env block configured, must NOT equal the active
 * provider, and cannot include `'filecoin'` (which is the canonical
 * active-only provider for this iteration; legacy Filecoin rows are
 * handled by the active store directly).
 */
function validateLegacyProviders(args: RawStorageValidationInput): void {
  for (const provider of args.legacyProviders) {
    if (provider === args.provider) {
      throw new Error(
        `RAW_STORAGE_LEGACY_PROVIDERS lists '${provider}', but that is the active provider. ` +
          'A provider cannot be both active and legacy.',
      );
    }
    if (provider === 'filecoin') {
      throw new Error(
        `RAW_STORAGE_LEGACY_PROVIDERS cannot include '${provider}'. ` +
          'Filecoin-family rows are served by the active store, not via legacy registration.',
      );
    }
    const missing = provider === 'local_fs'
      ? collectMissingLocalFsFields(args)
      : collectMissingS3Fields(args);
    if (missing.length > 0) {
      throw new Error(
        `RAW_STORAGE_LEGACY_PROVIDERS='${provider}' requires its full env block: ${missing.join(', ')}.`,
      );
    }
  }
}

const embeddingProvider = parseEmbeddingProvider(optionalEnv('EMBEDDING_PROVIDER'), 'openai');
const llmProvider = parseLlmProvider(optionalEnv('LLM_PROVIDER'), 'openai');
const retrievalProfile = parseRetrievalProfile(optionalEnv('RETRIEVAL_PROFILE'));
const retrievalProfileSettings = getRetrievalProfile(retrievalProfile);
const DEFAULT_SIMILARITY_THRESHOLD = 0.3;

/** Require OpenAI key only when at least one provider uses it. */
const needsOpenAIKey = embeddingProvider === 'openai' || llmProvider === 'openai';
const needsGroqKey = llmProvider === 'groq';
const needsAnthropicKey = llmProvider === 'anthropic';
const needsGoogleKey = llmProvider === 'google-genai';
const needsVoyageKey = embeddingProvider === 'voyage';
const groqApiKey = needsGroqKey ? requireEnv('GROQ_API_KEY') : optionalEnv('GROQ_API_KEY');
const openaiApiKey = needsOpenAIKey ? requireEnv('OPENAI_API_KEY') : (optionalEnv('OPENAI_API_KEY') ?? '');
const anthropicApiKey = needsAnthropicKey ? requireEnv('ANTHROPIC_API_KEY') : optionalEnv('ANTHROPIC_API_KEY');
const googleApiKey = needsGoogleKey ? requireEnv('GOOGLE_API_KEY') : optionalEnv('GOOGLE_API_KEY');
const voyageApiKey = needsVoyageKey ? requireEnv('VOYAGE_API_KEY') : optionalEnv('VOYAGE_API_KEY');

/**
 * Validate the hex-encoded HMAC secret used for storage-key prefix
 * derivation. Rejects values shorter than 64 hex chars (32 bytes) or
 * containing non-hex characters. Empty / missing values are caught
 * by `requireEnv` before this function runs.
 */
function parseStorageKeyHmacSecret(raw: string): string {
  const value = raw.trim();
  if (value.length < 64) {
    throw new Error(
      'STORAGE_KEY_HMAC_SECRET must be at least 64 hex chars (32 bytes of entropy).',
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error('STORAGE_KEY_HMAC_SECRET must be hex-encoded.');
  }
  return value.toLowerCase();
}

function parseUnitNumberEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1`);
  }
  return parsed;
}

export const config: RuntimeConfig = {
  databaseUrl: requireEnv('DATABASE_URL'),
  openaiApiKey,
  coreApiKey: requireEnv('CORE_API_KEY'),
  coreAdminApiKey: optionalEnv('CORE_ADMIN_API_KEY'),
  coreTestScopeAllowPattern: parseRegexEnv('CORE_TEST_SCOPE_ALLOW_PATTERN'),
  storageKeyHmacSecret: parseStorageKeyHmacSecret(requireEnv('STORAGE_KEY_HMAC_SECRET')),
  port: parseInt(process.env.PORT ?? '3050', 10),
  retrievalProfile,
  retrievalProfileSettings,
  maxSearchResults: retrievalProfileSettings.maxSearchResults,
  similarityThreshold: parseUnitNumberEnv('SIMILARITY_THRESHOLD', DEFAULT_SIMILARITY_THRESHOLD),
  audnCandidateThreshold: parseFloat(optionalEnv('AUDN_CANDIDATE_THRESHOLD') ?? '0.7'),
  audnSafeReuseMinSimilarity: parseFloat(optionalEnv('AUDN_SAFE_REUSE_MIN_SIMILARITY') ?? '0.95'),
  crossAgentCandidateThreshold: parseFloat(optionalEnv('CROSS_AGENT_CANDIDATE_THRESHOLD') ?? '0.75'),
  clarificationConflictThreshold: 0.8,
  adaptiveRetrievalEnabled: (process.env.ADAPTIVE_RETRIEVAL_ENABLED ?? String(retrievalProfileSettings.adaptiveRetrievalEnabled)) === 'true',
  adaptiveSimpleLimit: parsePositiveIntEnv('ADAPTIVE_SIMPLE_LIMIT', 5),
  adaptiveMediumLimit: parsePositiveIntEnv('ADAPTIVE_MEDIUM_LIMIT', 5),
  adaptiveComplexLimit: parsePositiveIntEnv('ADAPTIVE_COMPLEX_LIMIT', 8),
  adaptiveMultiHopLimit: parsePositiveIntEnv('ADAPTIVE_MULTI_HOP_LIMIT', 12),
  adaptiveAggregationLimit: parsePositiveIntEnv('ADAPTIVE_AGGREGATION_LIMIT', 25),
  repairLoopEnabled: (process.env.REPAIR_LOOP_ENABLED ?? String(retrievalProfileSettings.repairLoopEnabled)) === 'true',
  hybridSearchEnabled: (process.env.HYBRID_SEARCH_ENABLED ?? String(retrievalProfileSettings.hybridSearchEnabled)) === 'true',
  repairLoopMinSimilarity: parseFloat(process.env.REPAIR_LOOP_MIN_SIMILARITY ?? String(retrievalProfileSettings.repairLoopMinSimilarity)),
  repairSkipSimilarity: parseFloat(process.env.REPAIR_SKIP_SIMILARITY ?? String(retrievalProfileSettings.repairSkipSimilarity ?? 0.55)),
  mmrEnabled: (process.env.MMR_ENABLED ?? String(retrievalProfileSettings.mmrEnabled)) === 'true',
  mmrLambda: parseFloat(process.env.MMR_LAMBDA ?? String(retrievalProfileSettings.mmrLambda)),
  linkExpansionEnabled: (process.env.LINK_EXPANSION_ENABLED ?? String(retrievalProfileSettings.linkExpansionEnabled)) === 'true',
  linkExpansionMax: parseInt(process.env.LINK_EXPANSION_MAX ?? String(retrievalProfileSettings.linkExpansionMax), 10),
  linkSimilarityThreshold: parseFloat(process.env.LINK_SIMILARITY_THRESHOLD ?? String(retrievalProfileSettings.linkSimilarityThreshold)),
  scoringWeightSimilarity: parseFloat(process.env.SCORING_WEIGHT_SIMILARITY ?? String(retrievalProfileSettings.scoringWeightSimilarity)),
  scoringWeightImportance: parseFloat(process.env.SCORING_WEIGHT_IMPORTANCE ?? String(retrievalProfileSettings.scoringWeightImportance)),
  scoringWeightRecency: parseFloat(process.env.SCORING_WEIGHT_RECENCY ?? String(retrievalProfileSettings.scoringWeightRecency)),
  linkExpansionBeforeMMR: (process.env.LINK_EXPANSION_BEFORE_MMR ?? String(retrievalProfileSettings.linkExpansionBeforeMMR)) === 'true',
  pprEnabled: (process.env.PPR_ENABLED ?? 'false') === 'true',
  pprDamping: parseFloat(process.env.PPR_DAMPING ?? '0.5'),
  repairDeltaThreshold: parseFloat(process.env.REPAIR_DELTA_THRESHOLD ?? String(retrievalProfileSettings.repairDeltaThreshold)),
  repairConfidenceFloor: parseFloat(process.env.REPAIR_CONFIDENCE_FLOOR ?? String(retrievalProfileSettings.repairConfidenceFloor)),

  // Embedding provider
  embeddingProvider,
  embeddingModel: optionalEnv('EMBEDDING_MODEL') ?? 'text-embedding-3-small',
  embeddingDimensions: parseInt(requireEnv('EMBEDDING_DIMENSIONS'), 10),
  embeddingApiUrl: optionalEnv('EMBEDDING_API_URL'),
  embeddingApiKey: optionalEnv('EMBEDDING_API_KEY'),
  voyageApiKey: voyageApiKey ?? undefined,
  voyageDocumentModel: optionalEnv('VOYAGE_DOCUMENT_MODEL') ?? 'voyage-4-large',
  voyageQueryModel: optionalEnv('VOYAGE_QUERY_MODEL') ?? 'voyage-4-lite',

  // LLM provider
  llmProvider,
  llmModel: optionalEnv('LLM_MODEL') ?? defaultLlmModel(llmProvider),
  llmApiUrl: optionalEnv('LLM_API_URL'),
  llmApiKey: optionalEnv('LLM_API_KEY'),

  // Groq
  groqApiKey: groqApiKey ?? undefined,
  anthropicApiKey: anthropicApiKey ?? undefined,
  googleApiKey: googleApiKey ?? undefined,

  // Ollama
  ollamaBaseUrl: optionalEnv('OLLAMA_BASE_URL') ?? 'http://localhost:11434',
  vectorBackend: parseVectorBackend(optionalEnv('VECTOR_BACKEND')),
  skipVectorIndexes: (optionalEnv('SKIP_VECTOR_INDEXES') ?? 'false') === 'true',
  llmSeed: parseLlmSeed(optionalEnv('LLM_SEED')),
  stagedLoadingEnabled: (optionalEnv('STAGED_LOADING_ENABLED') ?? 'false') === 'true',
  retrievalTraceEnabled: (optionalEnv('RETRIEVAL_TRACE_ENABLED') ?? 'false') === 'true',
  ingestTraceDir: optionalEnv('INGEST_TRACE_DIR') ?? './.traces/ingest',
  ingestTraceEnabled: (optionalEnv('INGEST_TRACE_ENABLED') ?? 'false') === 'true',
  extractionCacheEnabled: (optionalEnv('EXTRACTION_CACHE_ENABLED') ?? 'false') === 'true',
  extractionCacheDir: optionalEnv('EXTRACTION_CACHE_DIR') ?? './.eval-cache',
  embeddingCacheEnabled: (optionalEnv('EMBEDDING_CACHE_ENABLED') ?? 'false') === 'true',
  chunkedExtractionEnabled: (optionalEnv('CHUNKED_EXTRACTION_ENABLED') ?? 'false') === 'true',
  chunkedExtractionFallbackEnabled: (optionalEnv('CHUNKED_EXTRACTION_FALLBACK_ENABLED') ?? 'false') === 'true',
  chunkSizeTurns: parseInt(optionalEnv('CHUNK_SIZE_TURNS') ?? '4', 10),
  chunkOverlapTurns: parseInt(optionalEnv('CHUNK_OVERLAP_TURNS') ?? '1', 10),
  consensusExtractionEnabled: (optionalEnv('CONSENSUS_EXTRACTION_ENABLED') ?? 'false') === 'true',
  consensusExtractionRuns: parseInt(optionalEnv('CONSENSUS_EXTRACTION_RUNS') ?? '3', 10),
  observationDateExtractionEnabled: (optionalEnv('OBSERVATION_DATE_EXTRACTION_ENABLED') ?? 'false') === 'true',
  quotedEntityExtractionEnabled: (optionalEnv('QUOTED_ENTITY_EXTRACTION_ENABLED') ?? 'false') === 'true',
  entropyGateEnabled: (optionalEnv('ENTROPY_GATE_ENABLED') ?? 'false') === 'true',
  entropyGateThreshold: parseFloat(optionalEnv('ENTROPY_GATE_THRESHOLD') ?? '0.35'),
  entropyGateAlpha: parseFloat(optionalEnv('ENTROPY_GATE_ALPHA') ?? '0.5'),
  affinityClusteringThreshold: parseFloat(optionalEnv('AFFINITY_CLUSTERING_THRESHOLD') ?? '0.85'),
  affinityClusteringMinSize: parseInt(optionalEnv('AFFINITY_CLUSTERING_MIN_SIZE') ?? '3', 10),
  affinityClusteringBeta: parseFloat(optionalEnv('AFFINITY_CLUSTERING_BETA') ?? '0.5'),
  affinityClusteringTemporalLambda: parseFloat(optionalEnv('AFFINITY_CLUSTERING_TEMPORAL_LAMBDA') ?? '0.1'),
  trustScoringEnabled: (optionalEnv('TRUST_SCORING_ENABLED') ?? 'false') === 'true',
  trustScoreMinThreshold: parseFloat(optionalEnv('TRUST_SCORE_MIN_THRESHOLD') ?? '0.3'),
  trustPenaltyEnabled: (optionalEnv('TRUST_PENALTY_ENABLED') ?? 'false') === 'true',
  auditLoggingEnabled: (optionalEnv('AUDIT_LOGGING_ENABLED') ?? 'false') === 'true',
  decayCycleEnabled: (optionalEnv('DECAY_CYCLE_ENABLED') ?? 'false') === 'true',
  decayRetentionThreshold: parseFloat(optionalEnv('DECAY_RETENTION_THRESHOLD') ?? '0.2'),
  decayMinAgeDays: parseInt(optionalEnv('DECAY_MIN_AGE_DAYS') ?? '7', 10),
  memoryCapEnabled: (optionalEnv('MEMORY_CAP_ENABLED') ?? 'false') === 'true',
  memoryCapMax: parseInt(optionalEnv('MEMORY_CAP_MAX') ?? '5000', 10),
  memoryCapWarnRatio: parseFloat(optionalEnv('MEMORY_CAP_WARN_RATIO') ?? '0.8'),
  entityGraphEnabled: (optionalEnv('ENTITY_GRAPH_ENABLED') ?? 'false') === 'true',
  entityResolutionThreshold: parseFloat(optionalEnv('ENTITY_RESOLUTION_THRESHOLD') ?? '0.92'),
  entitySearchMinSimilarity: parseFloat(optionalEnv('ENTITY_SEARCH_MIN_SIMILARITY') ?? '0.7'),
  lessonsEnabled: (optionalEnv('LESSONS_ENABLED') ?? 'false') === 'true',
  lessonSimilarityThreshold: parseFloat(optionalEnv('LESSON_SIMILARITY_THRESHOLD') ?? '0.75'),
  consensusValidationEnabled: (optionalEnv('CONSENSUS_VALIDATION_ENABLED') ?? 'false') === 'true',
  consensusMinMemories: parseInt(optionalEnv('CONSENSUS_MIN_MEMORIES') ?? '3', 10),
  queryExpansionEnabled: (optionalEnv('QUERY_EXPANSION_ENABLED') ?? 'false') === 'true',
  queryExpansionMinSimilarity: parseFloat(optionalEnv('QUERY_EXPANSION_MIN_SIMILARITY') ?? '0.5'),
  queryAugmentationEnabled: (optionalEnv('QUERY_AUGMENTATION_ENABLED') ?? 'false') === 'true',
  queryAugmentationMaxEntities: parseInt(optionalEnv('QUERY_AUGMENTATION_MAX_ENTITIES') ?? '5', 10),
  queryAugmentationMinSimilarity: parseFloat(optionalEnv('QUERY_AUGMENTATION_MIN_SIMILARITY') ?? '0.4'),
  crossEncoderEnabled: (optionalEnv('CROSS_ENCODER_ENABLED') ?? 'false') === 'true', // ms-marco hurts temporal queries; keep disabled until better model
  crossEncoderModel: optionalEnv('CROSS_ENCODER_MODEL') ?? 'Xenova/ms-marco-MiniLM-L-6-v2',
  crossEncoderDtype: parseCrossEncoderDtype(optionalEnv('CROSS_ENCODER_DTYPE')),
  iterativeRetrievalEnabled: (optionalEnv('ITERATIVE_RETRIEVAL_ENABLED') ?? 'false') === 'true',
  namespaceClassificationEnabled: (optionalEnv('NAMESPACE_CLASSIFICATION_ENABLED') ?? 'false') === 'true',
  fastAudnEnabled: (optionalEnv('FAST_AUDN_ENABLED') ?? 'true') === 'true',
  fastAudnDuplicateThreshold: parseFloat(optionalEnv('FAST_AUDN_DUPLICATE_THRESHOLD') ?? '0.95'),
  observationNetworkEnabled: (optionalEnv('OBSERVATION_NETWORK_ENABLED') ?? 'true') === 'true',
  agenticRetrievalEnabled: (optionalEnv('AGENTIC_RETRIEVAL_ENABLED') ?? 'false') === 'true',
  rerankSkipTopSimilarity: parseFloat(optionalEnv('RERANK_SKIP_TOP_SIMILARITY') ?? '0.85'),
  rerankSkipMinGap: parseFloat(optionalEnv('RERANK_SKIP_MIN_GAP') ?? '0.05'),
  literalListProtectionEnabled: (optionalEnv('LITERAL_LIST_PROTECTION_ENABLED') ?? 'false') === 'true',
  literalListProtectionMaxProtected: parsePositiveIntEnv('LITERAL_LIST_PROTECTION_MAX_PROTECTED', 3),
  temporalQueryConstraintEnabled: (optionalEnv('TEMPORAL_QUERY_CONSTRAINT_ENABLED') ?? 'false') === 'true',
  temporalQueryConstraintBoost: parseFloat(optionalEnv('TEMPORAL_QUERY_CONSTRAINT_BOOST') ?? '2'),
  deferredAudnEnabled: (optionalEnv('DEFERRED_AUDN_ENABLED') ?? 'false') === 'true',
  deferredAudnBatchSize: parseInt(optionalEnv('DEFERRED_AUDN_BATCH_SIZE') ?? '20', 10),
  compositeGroupingEnabled: (optionalEnv('COMPOSITE_GROUPING_ENABLED') ?? 'true') === 'true',
  compositeMinClusterSize: parseInt(optionalEnv('COMPOSITE_MIN_CLUSTER_SIZE') ?? '2', 10),
  compositeMaxClusterSize: parseInt(optionalEnv('COMPOSITE_MAX_CLUSTER_SIZE') ?? '3', 10),
  compositeSimilarityThreshold: parseFloat(optionalEnv('COMPOSITE_SIMILARITY_THRESHOLD') ?? '0.55'),
  costLoggingEnabled: (optionalEnv('COST_LOGGING_ENABLED') ?? 'false') === 'true',
  costLogDir: optionalEnv('COST_LOG_DIR') ?? 'data/cost-logs',
  costRunId: optionalEnv('COST_RUN_ID') ?? '',
  conflictAutoResolveMs: parseInt(optionalEnv('CONFLICT_AUTO_RESOLVE_MS') ?? '86400000', 10),
  tbcEnabled: (optionalEnv('TBC_ENABLED') ?? 'false') === 'true',
  hierarchicalRetrievalEnabled: (optionalEnv('HIERARCHICAL_RETRIEVAL_ENABLED') ?? 'false') === 'true',
  topicAbstractionEnabled: (optionalEnv('TOPIC_ABSTRACTION_ENABLED') ?? 'false') === 'true',
  topicSearchEnabled: (optionalEnv('TOPIC_SEARCH_ENABLED') ?? 'false') === 'true',
  rerankerEnabled: (optionalEnv('RERANKER_ENABLED') ?? 'false') === 'true',
  rerankerTopN: parseInt(optionalEnv('RERANKER_TOP_N') ?? '20', 10),
  recapLayerEnabled: (optionalEnv('RECAP_LAYER_ENABLED') ?? 'false') === 'true',
  recapMinClusterSize: parseInt(optionalEnv('RECAP_MIN_CLUSTER_SIZE') ?? '4', 10),
  recapSearchEnabled: (optionalEnv('RECAP_SEARCH_ENABLED') ?? 'false') === 'true',
  recapClusterPivot: (optionalEnv('RECAP_CLUSTER_PIVOT') === 'session' ? 'session' : 'topic'),
  counterEvidenceEnabled: (optionalEnv('COUNTER_EVIDENCE_ENABLED') ?? 'false') === 'true',
  packagingUseObservedAt: (optionalEnv('PACKAGING_USE_OBSERVED_AT') ?? 'false') === 'true',
  packagingDualDate: (optionalEnv('PACKAGING_DUAL_DATE') ?? 'false') === 'true',
  timelineChannelEnabled: (optionalEnv('TIMELINE_CHANNEL_ENABLED') ?? 'false') === 'true',
  answerOnlyRetrievalFilter: (optionalEnv('ANSWER_ONLY_RETRIEVAL_FILTER') ?? 'false') === 'true',
  retrievalDedupEnabled: (optionalEnv('RETRIEVAL_DEDUP_ENABLED') ?? 'false') === 'true',
  keywordRrfWeight: parseFloat(optionalEnv('KEYWORD_RRF_WEIGHT') ?? '1.0'),
  entityAttributesEnabled: (optionalEnv('ENTITY_ATTRIBUTES_ENABLED') ?? 'false') === 'true',
  entityAttributesTopK: parsePositiveIntEnv('ENTITY_ATTRIBUTES_TOP_K', 20),
  userProfileChannelEnabled: (optionalEnv('USER_PROFILE_CHANNEL_ENABLED') ?? 'false') === 'true',
  episodesChannelEnabled: (optionalEnv('EPISODES_CHANNEL_ENABLED') ?? 'false') === 'true',
  episodesChannelTopK: parseInt(optionalEnv('EPISODES_CHANNEL_TOP_K') ?? '2', 10),
  verifierPassEnabled: (optionalEnv('VERIFIER_PASS_ENABLED') ?? 'false') === 'true',
  answerFormatAlignmentEnabled: (optionalEnv('ANSWER_FORMAT_ALIGNMENT_ENABLED') ?? 'false') === 'true',
  eventChainPackagingEnabled: (optionalEnv('EVENT_CHAIN_PACKAGING_ENABLED') ?? 'false') === 'true',
  reflectEnabled: (optionalEnv('REFLECT_ENABLED') ?? 'false') === 'true',
  reflectRetrievalTopK: parsePositiveIntEnv('REFLECT_RETRIEVAL_TOP_K', 3),
  reflectModel: optionalEnv('REFLECT_MODEL') ?? 'claude-sonnet-4-5',
  reflectMaxObservations: parsePositiveIntEnv('REFLECT_MAX_OBSERVATIONS', 12),
  reflectJobPollMs: parsePositiveIntEnv('REFLECT_JOB_POLL_MS', 5000),
  reflectDebounceMs: parsePositiveIntEnv('REFLECT_DEBOUNCE_MS', 60000),
  runtimeConfigMutationEnabled:
    (process.env.CORE_RUNTIME_CONFIG_MUTATION_ENABLED ?? 'false') === 'true',
  phase2SpecialistsEnabled: (optionalEnv('PHASE2_SPECIALISTS_ENABLED') ?? 'false') === 'true',
  abstentionRescueEnabled: (optionalEnv('ABSTENTION_RESCUE_ENABLED') ?? 'false') === 'true',
  abstentionRescueRetrieveK: parseInt(optionalEnv('ABSTENTION_RESCUE_RETRIEVE_K') ?? '8', 10),
  abstentionRescueSonnetModel: optionalEnv('ABSTENTION_RESCUE_SONNET_MODEL') ?? 'claude-sonnet-4-5',
  confidencePrefixAdaptiveEnabled:
    (optionalEnv('CONFIDENCE_PREFIX_ADAPTIVE_ENABLED') ?? 'false') === 'true',
  kuRecencySortEnabled:
    (optionalEnv('KU_RECENCY_SORT_ENABLED') ?? 'false') === 'true',
  msrAggregatorEnabled: (optionalEnv('MSR_AGGREGATOR_ENABLED') ?? 'false') === 'true',
  entityCardEnabled: (optionalEnv('ENTITY_CARD_ENABLED') ?? 'false') === 'true',
  entityCardMaxPerSession: parsePositiveIntEnv('ENTITY_CARD_MAX_PER_SESSION', 5),
  entityCardMinObservations: parsePositiveIntEnv('ENTITY_CARD_MIN_OBSERVATIONS', 3),
  contradictionPreservationEnabled: (optionalEnv('CONTRADICTION_PRESERVATION_ENABLED') ?? 'false') === 'true',
  contradictionSurfacingEnabled: (optionalEnv('CONTRADICTION_SURFACING_ENABLED') ?? 'false') === 'true',
  temporalStateEnabled: (optionalEnv('TEMPORAL_STATE_ENABLED') ?? 'false') === 'true',
  rawStorageMode: parseRawStorageMode(optionalEnv('RAW_STORAGE_MODE')),
  rawStorageProvider: parseRawStorageProvider(optionalEnv('RAW_STORAGE_PROVIDER')),
  rawStoragePrefix: optionalEnv('RAW_STORAGE_PREFIX') ?? '',
  rawStorageLocalFsRoot: optionalEnv('RAW_STORAGE_LOCAL_FS_ROOT') ?? null,
  rawStorageS3Bucket: optionalEnv('RAW_STORAGE_S3_BUCKET') ?? null,
  rawStorageS3Region: optionalEnv('RAW_STORAGE_S3_REGION') ?? null,
  rawStorageS3Endpoint: optionalEnv('RAW_STORAGE_S3_ENDPOINT') ?? null,
  rawStorageS3AccessKeyId: optionalEnv('RAW_STORAGE_S3_ACCESS_KEY_ID') ?? null,
  rawStorageS3SecretAccessKey: optionalEnv('RAW_STORAGE_S3_SECRET_ACCESS_KEY') ?? null,
  rawUploadMaxBytes: parsePositiveIntEnv('RAW_UPLOAD_MAX_BYTES', 26214400 /* 25 MiB */),
  rawContentCodec: parseRawContentCodec(optionalEnv('RAW_CONTENT_CODEC')),
  rawContentCodecKeys: parseRawContentCodecKeys(optionalEnv('RAW_CONTENT_CODEC_KEYS')),
  rawContentCodecActiveKeyId: optionalEnv('RAW_CONTENT_CODEC_ACTIVE_KEY_ID') ?? null,
  rawStorageDeploymentEnv: parseRawStorageDeploymentEnv(optionalEnv('RAW_STORAGE_DEPLOYMENT_ENV')),
  filecoinProvider: null,
  rawStorageLegacyProviders: parseLegacyProviders(optionalEnv('RAW_STORAGE_LEGACY_PROVIDERS')),
  rawStoragePointerUriSchemes: parsePointerUriSchemes(
    optionalEnv('RAW_STORAGE_POINTER_URI_SCHEMES'),
  ),
};

const filecoinEnvKeysSet = collectFilecoinProviderEnvKeys(process.env);

validateRawStorageConfig({
  mode: config.rawStorageMode,
  provider: config.rawStorageProvider,
  prefix: config.rawStoragePrefix,
  localFsRoot: config.rawStorageLocalFsRoot,
  s3Bucket: config.rawStorageS3Bucket,
  s3Region: config.rawStorageS3Region,
  s3AccessKeyId: config.rawStorageS3AccessKeyId,
  s3SecretAccessKey: config.rawStorageS3SecretAccessKey,
  codec: config.rawContentCodec,
  codecKeys: config.rawContentCodecKeys,
  codecActiveKeyId: config.rawContentCodecActiveKeyId,
  deploymentEnv: config.rawStorageDeploymentEnv,
  legacyProviders: config.rawStorageLegacyProviders,
  filecoinEnvKeysSet,
});

if (config.rawStorageProvider === 'filecoin') {
  // Cross-provider guard above has already fired for non-filecoin
  // deployments carrying stray RAW_STORAGE_FILECOIN_* vars; this
  // branch validates the full Synapse-shaped block and fails closed
  // on missing / malformed values.
  config.filecoinProvider = parseFilecoinProviderConfig(process.env);
}

export function applyRuntimeConfigUpdates(
  target: RuntimeConfig,
  updates: RuntimeConfigUpdates,
): string[] {
  const applied: string[] = [];

  if (updates.similarityThreshold !== undefined) {
    target.similarityThreshold = requireFiniteNumber(updates.similarityThreshold, 'similarityThreshold');
    applied.push('similarityThreshold');
  }
  if (updates.audnCandidateThreshold !== undefined) {
    target.audnCandidateThreshold = requireFiniteNumber(updates.audnCandidateThreshold, 'audnCandidateThreshold');
    applied.push('audnCandidateThreshold');
  }
  if (updates.clarificationConflictThreshold !== undefined) {
    target.clarificationConflictThreshold = requireFiniteNumber(
      updates.clarificationConflictThreshold,
      'clarificationConflictThreshold',
    );
    applied.push('clarificationConflictThreshold');
  }
  if (updates.maxSearchResults !== undefined) {
    target.maxSearchResults = Math.max(1, Math.floor(requireFiniteNumber(updates.maxSearchResults, 'maxSearchResults')));
    applied.push('maxSearchResults');
  }

  return applied;
}

export function updateRuntimeConfig(updates: RuntimeConfigUpdates): string[] {
  return applyRuntimeConfigUpdates(config, updates);
}

/**
 * Public/supported operator config surface. Fields listed here are part of
 * v2's stable contract: consumers can rely on their semantics and presence,
 * and changes go through a documented deprecation cycle.
 *
 * This is a documentation type — it does not constrain threading. The runtime
 * still carries a single `RuntimeConfig` object; this array tags the public
 * subset so docs, tests, and future config-split work have a single source of
 * truth. See also: https://docs.atomicstrata.ai/platform/consuming-core.
 */
export const SUPPORTED_RUNTIME_CONFIG_FIELDS = [
  // Infrastructure
  'databaseUrl', 'openaiApiKey', 'coreApiKey', 'coreAdminApiKey',
  'coreTestScopeAllowPattern', 'storageKeyHmacSecret', 'port',
  // Provider / model selection (startup config)
  'embeddingProvider', 'embeddingModel', 'embeddingDimensions',
  'embeddingApiUrl', 'embeddingApiKey',
  'voyageApiKey', 'voyageDocumentModel', 'voyageQueryModel',
  'llmProvider', 'llmModel', 'llmApiUrl', 'llmApiKey',
  'groqApiKey', 'anthropicApiKey', 'googleApiKey',
  'ollamaBaseUrl', 'vectorBackend', 'skipVectorIndexes', 'llmSeed',
  'crossEncoderModel', 'crossEncoderDtype',
  // Operator-visible runtime
  'maxSearchResults', 'retrievalProfile', 'retrievalProfileSettings',
  // Major feature toggles (surfaced in GET /v1/memories/health)
  'entityGraphEnabled', 'lessonsEnabled', 'agenticRetrievalEnabled',
  'iterativeRetrievalEnabled', 'hybridSearchEnabled', 'repairLoopEnabled',
  'crossEncoderEnabled', 'auditLoggingEnabled', 'adaptiveRetrievalEnabled',
  'consensusValidationEnabled', 'namespaceClassificationEnabled',
  // Cost / cache ops
  'extractionCacheDir', 'costLogDir', 'costRunId', 'costLoggingEnabled',
  // Dev/test-only mutation gate for PUT /v1/memories/config
  // (see https://docs.atomicstrata.ai/platform/consuming-core)
  'runtimeConfigMutationEnabled',
] as const;

/**
 * Internal policy config — experimental / tuning flags. Fields here may
 * change semantics, defaults, or be removed without notice. Consumers should
 * NOT rely on these in production. Promoted into the supported contract when
 * a field's behavior stabilizes.
 */
export const INTERNAL_POLICY_CONFIG_FIELDS = [
  // Retrieval thresholds
  'similarityThreshold', 'audnCandidateThreshold', 'audnSafeReuseMinSimilarity',
  'crossAgentCandidateThreshold', 'clarificationConflictThreshold',
  // Repair loop tuning
  'repairLoopMinSimilarity', 'repairSkipSimilarity',
  'repairDeltaThreshold', 'repairConfidenceFloor',
  // Adaptive retrieval tuning
  'adaptiveSimpleLimit', 'adaptiveMediumLimit', 'adaptiveComplexLimit',
  'adaptiveMultiHopLimit', 'adaptiveAggregationLimit',
  // MMR
  'mmrEnabled', 'mmrLambda',
  // Link expansion
  'linkExpansionEnabled', 'linkExpansionMax',
  'linkSimilarityThreshold', 'linkExpansionBeforeMMR',
  // Scoring weights
  'scoringWeightSimilarity', 'scoringWeightImportance', 'scoringWeightRecency',
  // PPR
  'pprEnabled', 'pprDamping',
  // Staging / tracing
  'stagedLoadingEnabled', 'retrievalTraceEnabled', 'ingestTraceDir', 'ingestTraceEnabled',
  // Extraction internals
  'extractionCacheEnabled', 'embeddingCacheEnabled',
  'chunkedExtractionEnabled', 'chunkedExtractionFallbackEnabled',
  'chunkSizeTurns', 'chunkOverlapTurns',
  'consensusExtractionEnabled', 'consensusExtractionRuns',
  'observationDateExtractionEnabled', 'quotedEntityExtractionEnabled',
  'entropyGateEnabled', 'entropyGateThreshold', 'entropyGateAlpha',
  // Affinity clustering
  'affinityClusteringThreshold', 'affinityClusteringMinSize',
  'affinityClusteringBeta', 'affinityClusteringTemporalLambda',
  // Trust
  'trustScoringEnabled', 'trustScoreMinThreshold', 'trustPenaltyEnabled',
  // Decay / caps
  'decayCycleEnabled', 'decayRetentionThreshold', 'decayMinAgeDays',
  'memoryCapEnabled', 'memoryCapMax', 'memoryCapWarnRatio',
  // Entity tuning
  'entityResolutionThreshold', 'entitySearchMinSimilarity',
  // Lesson tuning
  'lessonSimilarityThreshold',
  // Consensus tuning
  'consensusMinMemories',
  // Query expansion / augmentation
  'queryExpansionEnabled', 'queryExpansionMinSimilarity',
  'queryAugmentationEnabled', 'queryAugmentationMaxEntities',
  'queryAugmentationMinSimilarity',
  // Rerank tuning
  'rerankSkipTopSimilarity', 'rerankSkipMinGap',
  // Literal/list answer selection
  'literalListProtectionEnabled', 'literalListProtectionMaxProtected',
  // Temporal query selection
  'temporalQueryConstraintEnabled', 'temporalQueryConstraintBoost',
  // Fast AUDN
  'fastAudnEnabled', 'fastAudnDuplicateThreshold',
  // Observation / deferred
  'observationNetworkEnabled', 'deferredAudnEnabled', 'deferredAudnBatchSize',
  // Composite grouping
  'compositeGroupingEnabled', 'compositeMinClusterSize',
  'compositeMaxClusterSize', 'compositeSimilarityThreshold',
  // Conflict handling
  'conflictAutoResolveMs',
  // Typed Belief Calculus (Phase 1 scaffold; gates future TBC behavior)
  'tbcEnabled',
  // Hierarchical Retrieval (T2; gates 5th RRF arm + summary table writes)
  'hierarchicalRetrievalEnabled',
  // Sprint 3 EO experiment: topic-abstraction ingest layer + retrieval channel
  'topicAbstractionEnabled',
  'topicSearchEnabled',
  // Sprint 3 v1: cross-encoder reranker on RRF top-N
  'rerankerEnabled',
  'rerankerTopN',
  // Sprint 3 v1: Recap (cross-session synthesis) layer
  'recapLayerEnabled',
  'recapMinClusterSize',
  'recapSearchEnabled',
  'recapClusterPivot',
  // Sprint 3 v1.1: counter-evidence retrieval via belief_edges graph
  'counterEvidenceEnabled',
  // Sprint 3 v1.2: temporal-aware packaging — surface observed_at not created_at
  'packagingUseObservedAt',
  // Sprint 3 v1.3: dual-date packaging — emit both created_at and observed_at
  'packagingDualDate',
  // Sprint 3 v1.4: timeline channel — dedicated ## TIMELINE prompt section
  'timelineChannelEnabled',
  // Sprint 4 iter 1: drop advisory-only memories from injection
  'answerOnlyRetrievalFilter',
  // Sprint 4 iter 2: dedup near-duplicates by content fingerprint
  'retrievalDedupEnabled',
  // Sprint 4 iter 3: BM25 keyword RRF weight (default 1.0; boost 1.5-2.0)
  'keywordRrfWeight',
  // Sprint 4: Entity-Attribute Index (EAI) — (entity, attribute, value) lookups
  'entityAttributesEnabled',
  'entityAttributesTopK',
  // Sprint 3 v1.5: user-profile channel — pinned `## USER PROFILE` block
  'userProfileChannelEnabled',
  // Sprint 3 v1.6: episodes-as-separate-channel — `## EPISODES` block sourced
  // from RecapStore candidates instead of RRF fan-in.
  'episodesChannelEnabled',
  'episodesChannelTopK',
  // Sprint 3 v1.7: verifier-pass — second LLM call re-grounds candidate answer.
  // Read by the AMB adapter via ATOMICMEMORY_VERIFIER_ENABLED; surfaced in
  // core config so iteration env files can request it for symmetry.
  'verifierPassEnabled',
  // BEAM-0.85 Phase 0 L1: answer-format alignment — prepends per-question-type
  // FORMAT hint to the injection prompt to shape answer-LLM output structure.
  'answerFormatAlignmentEnabled',
  // EO fix — data-driven event-chain detector: prepends ## EVENT_CHAIN channel
  // when retrieved top-K contains 3+ memories for same entity across 3+ dates.
  'eventChainPackagingEnabled',
  // BEAM-0.85 Phase 1: async reflection worker + retrieval channel.
  'reflectEnabled',
  'reflectRetrievalTopK',
  'reflectModel',
  'reflectMaxObservations',
  'reflectJobPollMs',
  'reflectDebounceMs',
  // BEAM-0.85 Phase 2: specialist dispatcher gate (CR, TR, MSR, IE/KU).
  'phase2SpecialistsEnabled',
  // Abstention-rescue: confidence prefix + iterative retrieval + Sonnet fallback.
  'abstentionRescueEnabled',
  'abstentionRescueRetrieveK',
  'abstentionRescueSonnetModel',
  // BEAM v36: per-question-type adaptive confidence prefix (forced vs soft vs none).
  'confidencePrefixAdaptiveEnabled',
  // BEAM v42: KU recency sort (NUMERIC_COUNT + KU-style queries → observed_at DESC).
  'kuRecencySortEnabled',
  // BEAM v39-multihop: MSR cross-conversation aggregator (retrieval-side channel).
  'msrAggregatorEnabled',
  // BEAM-0.85: always-on per-entity ENTITY_CARD channel (Honcho parity).
  'entityCardEnabled',
  'entityCardMaxPerSession',
  'entityCardMinObservations',
  // BEAM CR fix (2026-05-12): AUDN bilateral preservation for contradictions.
  'contradictionPreservationEnabled',
  'contradictionSurfacingEnabled',
  // BEAM v38 (2026-05-12): temporal state layer (write/read for KU).
  'temporalStateEnabled',
  // Document pipeline (Phases 1 + 3). The raw-storage knobs are
  // operator-visible at startup and intentionally NOT mutable at
  // runtime — moving the storage backend mid-process would orphan
  // already-persisted blobs.
  'rawStorageMode',
  'rawStorageProvider',
  'rawStoragePrefix',
  'rawStorageLocalFsRoot',
  'rawStorageS3Bucket',
  'rawStorageS3Region',
  'rawStorageS3Endpoint',
  'rawStorageS3AccessKeyId',
  'rawStorageS3SecretAccessKey',
  'rawUploadMaxBytes',
  // Filecoin raw storage: content codec + deployment env. Same
  // operator-visible-at-startup, not-runtime-mutable contract as the
  // raw-storage block above.
  'rawContentCodec',
  'rawContentCodecKeys',
  'rawContentCodecActiveKeyId',
  'rawStorageDeploymentEnv',
  // Synapse-shaped Filecoin provider config. Single grouped field on
  // `RuntimeConfig`; the underlying env var surface is
  // `RAW_STORAGE_FILECOIN_*` and the parser lives in
  // `src/storage/providers/filecoin/config.ts`.
  'filecoinProvider',
  'rawStorageLegacyProviders',
  'rawStoragePointerUriSchemes',
] as const;

export type SupportedRuntimeConfigField = typeof SUPPORTED_RUNTIME_CONFIG_FIELDS[number];
export type InternalPolicyConfigField = typeof INTERNAL_POLICY_CONFIG_FIELDS[number];
export type SupportedRuntimeConfig = Pick<RuntimeConfig, SupportedRuntimeConfigField>;
export type InternalPolicyConfig = Pick<RuntimeConfig, InternalPolicyConfigField>;
