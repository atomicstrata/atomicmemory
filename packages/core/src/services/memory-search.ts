/**
 * Search and retrieval orchestration for MemoryService.
 * Pure orchestration: delegates formatting to retrieval-format, dedup to
 * composite-dedup, side effects to retrieval-side-effects, lesson recording
 * to lesson-service, and the main retrieval to search-pipeline.
 */

import { type SearchResult } from '../db/memory-repository.js';
import { checkLessons, recordConsensusLessons, type LessonCheckResult } from './lesson-service.js';
import { validateConsensus, type ConsensusResult } from './consensus-validation.js';
import { embedText } from './embedding.js';
import { resolveSearchLimitDetailed, classifyQueryDetailed } from './retrieval-policy.js';
import { runSearchPipelineWithTrace } from './search-pipeline.js';
import { buildCitations as buildRichCitations, buildInjection, computePackagingSignal, type EpisodeForInjection } from './retrieval-format.js';
import type { ChainDetectorResult } from './event-chain-detector.js';
import type { Reflection } from '../db/reflections-repository.js';
import { QuestionType, classifyQuestion, isKuStyleQuery } from './answer-format.js';
import {
  fetchEntityFactsForInjection,
  fetchEpisodesForInjection,
  fetchUserProfileText,
  type EntityFactForInjection,
} from './episode-fetcher.js';
import { finalizePackagingTrace } from './packaging-observability.js';
import { isCurrentStateQuery } from './current-state-ranking.js';
import { TraceCollector } from './retrieval-trace.js';
import { excludeStaleComposites } from './composite-staleness.js';
import { applyFlatPackagingPolicy } from './composite-dedup.js';
import { recordSearchSideEffects } from './retrieval-side-effects.js';
import {
  applyRelevanceFilter,
  resolveRelevanceGate,
  type RelevanceFilterDecision,
} from './relevance-policy.js';
import { appendTllAugmentation } from './tll-augmentation.js';
import type { AgentScope, WorkspaceContext } from '../db/repository-types.js';
import type { MemoryServiceDeps, RetrievalOptions, RetrievalResult } from './memory-service-types.js';
import { dispatchSpecialists } from './specialists/dispatch.js';
import {
  applyConfidencePrefix,
  detectAbstention,
  extractKeywordsFromQuery,
  callSonnetRescue,
} from './answer-rescue.js';
import {
  buildContradictionsBlock,
  enrichTopKWithContradictions,
} from './contradiction-surfacing.js';
import { isMsrQuery } from './msr-detector.js';
import { aggregateByConversation } from './msr-aggregator.js';
import { llm as defaultLlm } from './llm.js';
import { applyTemporalStateRerank } from './temporal-rerank.js';
import { TemporalIntent, classifyTemporalIntent } from './temporal-intent.js';

interface RelevanceFilterSummary {
  threshold: number | null;
  source: string;
  reason: string;
  queryLabel: string;
  removedIds: string[];
  decisions: RelevanceFilterDecision[];
}

interface PostProcessedSearch {
  memories: SearchResult[];
  consensusResult?: ConsensusResult;
  relevanceFilter: RelevanceFilterSummary;
}

interface PackagedSearchOutput {
  mode: RetrievalResult['retrievalMode'];
  outputMemories: SearchResult[];
  injectionText: string;
  tierAssignments: ReturnType<typeof buildInjection>['tierAssignments'];
  expandIds: ReturnType<typeof buildInjection>['expandIds'];
  estimatedContextTokens: ReturnType<typeof buildInjection>['estimatedContextTokens'];
  budgetConstrained: boolean;
  packagingSummary: ReturnType<typeof finalizePackagingTrace>['packagingSummary'];
  assemblySummary: ReturnType<typeof finalizePackagingTrace>['assemblySummary'];
}

export interface PerformSearchInput {
  userId: string;
  query: string;
  sourceSite?: string;
  limit?: number;
  asOf?: string;
  referenceTime?: Date;
  namespaceScope?: string;
  retrievalOptions?: RetrievalOptions;
  sessionId?: string;
}

/**
 * Fetch a contradiction counterpart memory and shape it as a SearchResult.
 * Includes expired rows because contradiction counterparts may have been
 * superseded by an earlier (pre-bilateral) AUDN path and we still want
 * to surface them when their pair is active.
 * Returns null if the row is missing or hard-deleted.
 */
async function fetchCounterpartAsSearchResult(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  queryEmbedding: number[],
): Promise<SearchResult | null> {
  const rows = await deps.stores.search.fetchMemoriesByIds(
    userId, [memoryId], queryEmbedding, undefined, true,
  );
  return rows[0] ?? null;
}

/**
 * MSR cross-conversation aggregation (v39-multihop). Returns an aggregated
 * per-conversation summary block when the flag is on AND the query is
 * classified as multi-session-reasoning. Returns undefined otherwise so the
 * caller can skip the channel without branching.
 *
 * Fail-closed by delegation: `aggregateByConversation` throws on any LLM
 * error, which propagates and aborts the search — matching the AUDN-style
 * "no silent degradation" invariant.
 */
async function maybeBuildMsrAggregationBlock(
  deps: MemoryServiceDeps,
  memories: ReadonlyArray<SearchResult>,
  query: string,
): Promise<string | undefined> {
  if (!deps.config.msrAggregatorEnabled) return undefined;
  if (!isMsrQuery(query)) return undefined;
  if (memories.length === 0) return undefined;
  const aggregated = await aggregateByConversation(memories, query, {
    llm: defaultLlm,
    model: deps.config.llmModel,
  });
  return aggregated.length > 0 ? aggregated : undefined;
}

/** Check lessons safety gate; returns undefined if lessons disabled. */
async function checkSearchLessons(deps: MemoryServiceDeps, userId: string, query: string): Promise<LessonCheckResult | undefined> {
  if (!deps.config.lessonsEnabled || !deps.stores.lesson) return undefined;
  return checkLessons(deps.stores.lesson, userId, query);
}

/**
 * Always-on ENTITY_CARD channel renderer. Reads the top entity cards for
 * the active conversation and renders them as a `## ENTITY_STATE` block.
 * Returns undefined when the channel is off, the store is missing, or the
 * conversationId is not in the request — never throws so a degraded
 * channel does not break retrieval.
 */
async function fetchEntityStateBlock(
  deps: MemoryServiceDeps,
  userId: string,
  conversationId: string | undefined,
  questionType: QuestionType,
): Promise<string | undefined> {
  if (!deps.config.entityCardEnabled) return undefined;
  // Per-question-type gating: v27b c1 A/B under gpt-5.4-mini-semantic showed
  // ENTITY_CARDS lift PF by +0.375 but regress CR by -0.125 and SUM by -0.20.
  // Card synthesis compresses contradictions (loses both sides) and trims
  // narrative breadth (hurts comprehensive summaries). Suppress the channel
  // for those two question types; keep it on by default for everything else.
  if (questionType === QuestionType.CONTRADICTION) return undefined;
  if (questionType === QuestionType.SUMMARY) return undefined;
  const store = deps.stores.entityCards;
  if (!store) return undefined;
  // BEAM/AMB note: the AMB adapter encodes BEAM's conversation_id INTO user_id
  // (each conversation lives in its own user-id namespace). When no explicit
  // conversationId is in the request, fall back to userId so the channel still
  // fires in benchmark harnesses that do not forward conversation_id.
  const convScope = conversationId ?? userId;
  const cards = await store.findByConversation(userId, convScope, 5);
  if (cards.length === 0) return undefined;
  const userCard = cards.find((c) => c.entityName.toLowerCase() === 'user');
  const ordered = userCard
    ? [userCard, ...cards.filter((c) => c !== userCard)]
    : cards;
  const sections = ordered.map((c) => `### ${c.entityName.toUpperCase()}\n${c.cardText}`);
  return `## ENTITY_STATE (pre-synthesized, always-on)\n${sections.join('\n')}\n\n`;
}

/** Try to resolve an atomicmem:// URI query. Returns result or null. */
async function tryUriResolution(
  deps: MemoryServiceDeps,
  query: string,
  userId: string,
  retrievalOptions: RetrievalOptions | undefined,
  trace: TraceCollector,
): Promise<RetrievalResult | null> {
  if (!query.startsWith('atomicmem://')) return null;
  const uriTier = retrievalOptions?.retrievalMode === 'flat' ? 'L2' : 'L1';
  const resolved = await deps.uriResolver.resolve(query, userId, uriTier);
  if (!resolved) return null;

  const resultMemories = Array.isArray(resolved.data) ? resolved.data : [resolved.data];
  trace.event('uri-resolution', { uri: query, type: resolved.type, tier: uriTier });
  trace.finalize(resultMemories);
  return {
    memories: resultMemories,
    injectionText: deps.uriResolver.format(resolved),
    citations: resultMemories.map((m: any) => m.id),
    retrievalMode: retrievalOptions?.retrievalMode ?? 'flat',
    budgetConstrained: false,
  };
}

/** Execute the core search (as-of or pipeline). */
async function executeSearchStep(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  effectiveLimit: number,
  sourceSite: string | undefined,
  referenceTime: Date | undefined,
  namespaceScope: string | undefined,
  sessionId: string | undefined,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  trace: TraceCollector,
): Promise<{ memories: SearchResult[]; activeTrace: TraceCollector; queryEmbedding: number[]; chainResult: ChainDetectorResult; reflections: Reflection[]; questionType: QuestionType }> {
  if (asOf) {
    const queryEmbedding = await embedText(query, 'query');
    const memories = await deps.stores.claim.searchClaimVersions(userId, queryEmbedding, effectiveLimit, asOf, sourceSite);
    trace.stage('as-of-search', memories, { asOf });
    return { memories, activeTrace: trace, queryEmbedding, chainResult: { chains: [] }, reflections: [], questionType: QuestionType.OTHER };
  }
  const pipelineStores = {
    search: deps.stores.search,
    link: deps.stores.link,
    memory: deps.stores.memory,
    entity: deps.stores.entity,
    summaries: deps.stores.summaries,
    recap: deps.stores.recap,
    reflections: deps.stores.reflections,
    pool: deps.stores.pool,
  };
  const pipelineResult = await runSearchPipelineWithTrace(pipelineStores, userId, query, effectiveLimit, sourceSite, referenceTime, {
    namespaceScope,
    sessionId,
    retrievalMode: retrievalOptions?.retrievalMode,
    searchStrategy: retrievalOptions?.searchStrategy,
    skipRepairLoop: retrievalOptions?.skipRepairLoop,
    skipReranking: retrievalOptions?.skipReranking,
    runtimeConfig: deps.config,
  });
  return {
    memories: pipelineResult.filtered,
    activeTrace: pipelineResult.trace,
    queryEmbedding: pipelineResult.queryEmbedding,
    chainResult: pipelineResult.chainResult,
    reflections: pipelineResult.reflections,
    questionType: pipelineResult.questionType,
  };
}

/** Filter workspace-scoped, stale composites, and consensus-violating memories. */
async function postProcessResults(
  deps: MemoryServiceDeps,
  rawMemories: SearchResult[],
  activeTrace: TraceCollector,
  userId: string,
  query: string,
  asOf: string | undefined,
  sourceSite: string | undefined,
  retrievalOptions: RetrievalOptions | undefined,
): Promise<PostProcessedSearch> {
  let memories = rawMemories.filter((m) => !m.workspace_id);

  if (!asOf) {
    const compositeResult = await excludeStaleComposites(deps.stores.memory, userId, memories);
    if (compositeResult.removedCompositeIds.length > 0) {
      memories = compositeResult.filtered;
      activeTrace.stage('stale-composite-filter', memories, {
        removedCount: compositeResult.removedCompositeIds.length,
        removedIds: compositeResult.removedCompositeIds,
      });
    }
  }

  let consensusResult: ConsensusResult | undefined;

  if (deps.config.consensusValidationEnabled && memories.length >= deps.config.consensusMinMemories) {
    consensusResult = await validateConsensus(query, memories);
    if (consensusResult.removedMemoryIds.length > 0) {
      const removedSet = new Set(consensusResult.removedMemoryIds);
      memories = memories.filter((m) => !removedSet.has(m.id));
      activeTrace.stage('consensus-filter', memories, {
        removedCount: consensusResult.removedMemoryIds.length,
        removedIds: consensusResult.removedMemoryIds,
      });
      if (deps.config.lessonsEnabled && deps.stores.lesson) {
        recordConsensusLessons(deps.stores.lesson, userId, consensusResult, memories).catch(
          (err) => console.error('Consensus lesson recording failed:', err),
        );
      }
    }
  }

  const relevanceFilter = applySearchRelevanceFilter(
    memories,
    activeTrace,
    query,
    retrievalOptions,
    deps.config,
    { asOf, sourceSite },
  );
  return { memories: relevanceFilter.memories, consensusResult, relevanceFilter };
}

function applySearchRelevanceFilter(
  memories: SearchResult[],
  activeTrace: TraceCollector,
  query: string,
  retrievalOptions: RetrievalOptions | undefined,
  runtimeConfig: MemoryServiceDeps['config'],
  gateContext: { asOf?: string; sourceSite?: string } = {},
): RelevanceFilterSummary & { memories: SearchResult[] } {
  const gate = resolveRelevanceGate(query, retrievalOptions?.relevanceThreshold, runtimeConfig, gateContext);
  const result = applyRelevanceFilter(memories, gate);
  const summary = {
    threshold: gate.threshold,
    source: gate.source,
    reason: gate.reason,
    queryLabel: gate.queryLabel,
    removedIds: result.removedIds,
    decisions: result.decisions,
  };
  activeTrace.stage('relevance-filter', result.memories, {
    ...summary,
    removedCount: result.removedIds.length,
  });
  return { ...summary, memories: result.memories };
}

/** Package memories, build injection text, and assemble the final response. */
async function assembleResponse(
  deps: MemoryServiceDeps,
  postProcessed: PostProcessedSearch,
  query: string,
  userId: string,
  activeTrace: TraceCollector,
  retrievalOptions: RetrievalOptions | undefined,
  asOf: string | undefined,
  sourceSite: string | undefined,
  lessonCheck: LessonCheckResult | undefined,
  queryEmbedding: number[],
  chainResult?: ChainDetectorResult,
  reflections?: readonly Reflection[],
  questionType: QuestionType = QuestionType.OTHER,
): Promise<RetrievalResult> {
  // Phase 2 specialist short-circuit — runs before buildInjection + answer LLM.
  if (deps.config.phase2SpecialistsEnabled) {
    const specialistResult = await dispatchSpecialists({
      memories: postProcessed.memories.map((m) => ({
        id: m.id,
        text: m.content,
        observedAt: m.observed_at,
      })),
      query,
      userId,
      model: deps.config.llmModel,
      beliefEdges: deps.stores.beliefEdges ?? null,
      memoryRepo: deps.stores.memory,
      entityValues: deps.stores.entityValues ?? null,
    });
    if (specialistResult.handled) {
      return {
        memories: postProcessed.memories,
        injectionText: '',
        citations: postProcessed.memories.map((m) => m.id),
        retrievalMode: retrievalOptions?.retrievalMode ?? 'flat',
        budgetConstrained: false,
        lessonCheck,
        consensusResult: postProcessed.consensusResult,
        specialistAnswer: specialistResult.answer,
      };
    }
  }
  const userProfileText = await fetchUserProfileText(deps, userId);
  const episodes = deps.config.episodesChannelEnabled
    ? await fetchEpisodesForInjection(deps, userId, queryEmbedding)
    : [];
  const entityFacts = await fetchEntityFactsForInjection(deps, userId, query);
  const entityStateBlock = await fetchEntityStateBlock(
    deps, userId, retrievalOptions?.conversationId, questionType,
  );
  // BEAM CR fix: bilateral surfacing. When the flag is on, augment top-K with
  // contradiction counterparts and capture both-sides verbatim pairs to
  // render as `## CONTRADICTIONS_DETECTED`.
  const enrichment = await enrichTopKWithContradictions({
    userId,
    memories: postProcessed.memories,
    contradictions: deps.stores.contradictions,
    enabled: deps.config.contradictionSurfacingEnabled,
    fetchCounterpart: (memoryId) => fetchCounterpartAsSearchResult(deps, userId, memoryId, queryEmbedding),
  });
  const enrichedPostProcessed: PostProcessedSearch = {
    ...postProcessed,
    memories: enrichment.memories,
  };
  const contradictionsBlock = buildContradictionsBlock(enrichment.pairs, questionType);
  const msrAggregationBlock = await maybeBuildMsrAggregationBlock(
    deps, enrichment.memories, query,
  );
  const packaged = packageSearchOutput(
    enrichedPostProcessed, query, activeTrace, retrievalOptions,
    userProfileText, episodes, entityFacts, deps.config, chainResult, reflections, questionType,
    entityStateBlock, contradictionsBlock, msrAggregationBlock,
  );
  recordSearchSideEffects(deps, packaged.outputMemories, userId, query, sourceSite, asOf);
  updateRetrievalSummary(activeTrace, packaged.outputMemories, query, retrievalOptions, postProcessed.relevanceFilter);
  activeTrace.finalize(packaged.outputMemories);
  return buildRetrievalResult(postProcessed, packaged, activeTrace, lessonCheck);
}

/**
 * BEAM v42 KU recency reorder. Gated by `kuRecencySortEnabled`, restricted to
 * NUMERIC_COUNT queries that also match the KU-style framing
 * ("what is the average/current/latest/daily X"). Reorders packaged retrieval
 * by observed_at DESC so the most recent measurement appears first for the
 * answer LLM. Keeps ALL memories — pure reorder. Targets KU Mode B
 * (wrong-value-forced) where Haiku picks the earlier of two competing values.
 */
function maybeApplyKuRecencySort(
  packaged: SearchResult[],
  query: string,
  questionType: QuestionType,
  runtimeConfig: MemoryServiceDeps['config'],
  activeTrace: TraceCollector,
): SearchResult[] {
  if (!runtimeConfig.kuRecencySortEnabled) return packaged;
  if (questionType !== QuestionType.NUMERIC_COUNT) return packaged;
  if (!isKuStyleQuery(query)) return packaged;
  const sorted = [...packaged].sort(
    (a, b) => b.observed_at.getTime() - a.observed_at.getTime(),
  );
  activeTrace.event('ku-recency-sort', {
    candidateCount: sorted.length,
    orderedIds: sorted.map((m) => m.id),
  });
  return sorted;
}

// fallow-ignore-next-line complexity
function packageSearchOutput(
  postProcessed: PostProcessedSearch,
  query: string,
  activeTrace: TraceCollector,
  retrievalOptions: RetrievalOptions | undefined,
  userProfileText: string | undefined,
  episodes: EpisodeForInjection[],
  entityFacts: EntityFactForInjection[],
  runtimeConfig: MemoryServiceDeps['config'],
  chainResult?: ChainDetectorResult,
  reflections?: readonly Reflection[],
  questionType: QuestionType = QuestionType.OTHER,
  entityStateBlock?: string,
  contradictionsBlock?: string,
  msrAggregationBlock?: string,
): PackagedSearchOutput {
  const mode = retrievalOptions?.retrievalMode ?? 'flat';
  const packaged = applyFlatPackagingPolicy(postProcessed.memories, query, mode, activeTrace);
  // Sort current-state queries by `ranking_score` (floor-gated) rather than
  // the raw `score` formula. The raw `score` ignores the
  // `ranking-min-similarity` floor and lets a high-importance / heavily-linked
  // memory dominate the response even when its semantic similarity is low —
  // see the "what editor does the user prefer" regression where a low-sim
  // composite outranked the actually-relevant Neovim memory.
  const baseOrdered = isCurrentStateQuery(query)
    ? packaged.sort((a, b) => (b.ranking_score ?? b.score) - (a.ranking_score ?? a.score))
    : packaged;
  const outputMemories = maybeApplyKuRecencySort(baseOrdered, query, questionType, runtimeConfig, activeTrace);
  const buildResult = buildInjection(
    outputMemories, query, mode, retrievalOptions?.tokenBudget,
    userProfileText, episodes, entityFacts, chainResult?.chains, reflections, questionType,
  );
  const { tierAssignments, expandIds, estimatedContextTokens } = buildResult;
  const renderedMemories = buildResult.includedMemories;
  // CONTRADICTIONS_DETECTED block (BEAM CR fix) is prepended above
  // ENTITY_STATE so the answer LLM sees both sides verbatim before any
  // compressed entity summary that may have lost the contradiction.
  const bodyWithContradictions = contradictionsBlock
    ? `${contradictionsBlock}${buildResult.injectionText}`
    : buildResult.injectionText;
  // ENTITY_STATE channel: prepend the always-on per-entity cards block above
  // every other channel so the answer LLM has canonical user state up front.
  const bodyWithEntityState = entityStateBlock
    ? `${entityStateBlock}${bodyWithContradictions}`
    : bodyWithContradictions;
  // MSR cross-conversation aggregation (v39-multihop): prepend above
  // ENTITY_STATE so the answer LLM sees per-conversation summaries BEFORE
  // the raw chunks that triggered the misjoin.
  const bodyWithMsr = msrAggregationBlock
    ? `## CROSS-SESSION SUMMARY\n${msrAggregationBlock}\n\n${bodyWithEntityState}`
    : bodyWithEntityState;
  // Confidence-priming prefix: prepend when abstention rescue is enabled so the
  // external answer LLM commits to facts it can see rather than hedging.
  const injectionText = applyConfidencePrefix(
    bodyWithMsr,
    runtimeConfig.abstentionRescueEnabled,
    {
      adaptive: runtimeConfig.confidencePrefixAdaptiveEnabled,
      questionType,
    },
  );
  const { packagingSummary, assemblySummary } = finalizePackagingTrace(activeTrace, {
    outputMemories: renderedMemories, mode, injectionText, estimatedContextTokens, tierAssignments,
    tokenBudget: retrievalOptions?.tokenBudget,
  });
  return {
    mode,
    outputMemories: renderedMemories,
    injectionText,
    tierAssignments,
    expandIds,
    estimatedContextTokens,
    budgetConstrained: buildResult.budgetConstrained,
    packagingSummary,
    assemblySummary,
  };
}

function updateRetrievalSummary(
  activeTrace: TraceCollector,
  outputMemories: SearchResult[],
  query: string,
  retrievalOptions: RetrievalOptions | undefined,
  relevanceFilter: RelevanceFilterSummary,
): void {
  const priorSummary = activeTrace.getRetrievalSummary();
  activeTrace.setRetrievalSummary({
    candidateIds: outputMemories.map((memory) => memory.id),
    candidateCount: outputMemories.length,
    queryText: priorSummary?.queryText ?? query,
    skipRepair: priorSummary?.skipRepair ?? retrievalOptions?.skipRepairLoop ?? false,
    relevanceThreshold: relevanceFilter.threshold,
    relevanceFilterSource: relevanceFilter.source,
    relevanceFilterReason: relevanceFilter.reason,
    filteredCandidateIds: relevanceFilter.removedIds,
    filterDecisions: relevanceFilter.decisions,
  });
}

function buildRetrievalResult(
  postProcessed: PostProcessedSearch,
  packaged: PackagedSearchOutput,
  activeTrace: TraceCollector,
  lessonCheck: LessonCheckResult | undefined,
): RetrievalResult {
  return {
    memories: packaged.outputMemories,
    injectionText: packaged.injectionText,
    citations: buildRichCitations(packaged.outputMemories).map((c) => c.memory_id),
    retrievalMode: packaged.mode,
    tierAssignments: packaged.tierAssignments,
    expandIds: packaged.expandIds,
    estimatedContextTokens: packaged.estimatedContextTokens,
    budgetConstrained: packaged.budgetConstrained,
    lessonCheck, consensusResult: postProcessed.consensusResult,
    packagingSignal: computePackagingSignal(packaged.outputMemories),
    retrievalSummary: activeTrace.getRetrievalSummary(),
    packagingSummary: packaged.packagingSummary,
    assemblySummary: packaged.assemblySummary,
  };
}

/** Full search with lesson check, URI resolution, pipeline, post-processing, and packaging. */
export async function performSearch(
  deps: MemoryServiceDeps,
  input: PerformSearchInput,
): Promise<RetrievalResult> {
  const {
    userId,
    query,
    sourceSite,
    limit,
    asOf,
    referenceTime,
    namespaceScope,
    retrievalOptions,
    sessionId,
  } = input;
  const lessonCheck = await checkSearchLessons(deps, userId, query);
  if (lessonCheck && !lessonCheck.safe) {
    return {
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: retrievalOptions?.retrievalMode ?? 'flat',
      budgetConstrained: false,
      lessonCheck,
    };
  }

  const { limit: effectiveLimit, classification } = resolveSearchLimitDetailed(query, limit, deps.config);
  const trace = new TraceCollector(query, userId);
  trace.event('query-classification', { label: classification.label, limit: effectiveLimit, matchedMarker: classification.matchedMarker });

  const uriResult = await tryUriResolution(deps, query, userId, retrievalOptions, trace);
  if (uriResult) return uriResult;

  const { memories: rawMemories, activeTrace, queryEmbedding, chainResult, reflections, questionType } = await executeSearchStep(deps, userId, query, effectiveLimit, sourceSite, referenceTime, namespaceScope, sessionId, retrievalOptions, asOf, trace);
  const filteredMemories = await postProcessResults(
    deps, rawMemories, activeTrace, userId, query, asOf, sourceSite, retrievalOptions,
  );
  const reranked = maybeApplyTemporalRerank(filteredMemories, query, deps.config, activeTrace);
  const augmented = await appendTllAugmentation(deps, userId, query, reranked, effectiveLimit, activeTrace);
  return assembleResponse(deps, augmented, query, userId, activeTrace, retrievalOptions, asOf, sourceSite, lessonCheck, queryEmbedding, chainResult, reflections, questionType);
}

/**
 * BEAM v38 read seam — when `temporalStateEnabled` is on and the query
 * intent is CURRENT_STATE, additively rerank candidates by their
 * state_key activity. Always returns the same record shape so the rest
 * of the pipeline is unaware of the optional channel.
 */
function maybeApplyTemporalRerank(
  postProcessed: PostProcessedSearch,
  query: string,
  runtimeConfig: MemoryServiceDeps['config'],
  activeTrace: TraceCollector,
): PostProcessedSearch {
  if (!runtimeConfig.temporalStateEnabled) return postProcessed;
  const intent = classifyTemporalIntent(query);
  if (intent !== TemporalIntent.CURRENT_STATE) return postProcessed;
  const reranked = applyTemporalStateRerank(postProcessed.memories);
  activeTrace.event('temporal-state-rerank', {
    intent,
    candidateCount: reranked.length,
    activeIds: reranked
      .filter((m) => m.state_key && (m.event_end === null || m.event_end === undefined))
      .map((m) => m.id),
  });
  return { ...postProcessed, memories: reranked };
}

/**
 * Latency-optimized search that skips repair/reranking for simple and medium
 * queries, but escalates to the full pipeline for multi-hop, aggregation, and
 * complex queries where the LLM rewrite materially improves retrieval.
 */
export async function performFastSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  sourceSite?: string,
  limit?: number,
  namespaceScope?: string,
  sessionId?: string,
  retrievalOptions?: RetrievalOptions,
): Promise<RetrievalResult> {
  const label = classifyQueryDetailed(query).label;
  const escalate = label === 'multi-hop' || label === 'aggregation' || label === 'complex';
  // Fast search owns these latency toggles based on query class; caller options
  // still flow through for packaging, threshold, and strategy controls.
  return performSearch(deps, {
    userId,
    query,
    sourceSite,
    limit,
    namespaceScope,
    retrievalOptions: {
      ...retrievalOptions,
      skipRepairLoop: !escalate,
      skipReranking: !escalate,
    },
    sessionId,
  });
}

/**
 * Options for the abstention-rescue retrieval pass.
 */
export interface RescueSearchOptions {
  /** Original query that produced the abstaining answer. */
  query: string;
  /** Answer text produced by the first LLM pass (checked for abstention). */
  candidateAnswer: string;
  /** userId scoping this retrieval. */
  userId: string;
  /** Injection text from the first pass (used as system context for Sonnet rescue). */
  firstInjectionText: string;
}

/**
 * Abstention-rescue search: runs a second retrieval pass with keyword-augmented
 * query and returns either a merged injectionText (for Haiku re-prompt) or a
 * Sonnet-rescue answer (via specialistAnswer) when Haiku still abstains.
 *
 * Only fires when `abstentionRescueEnabled` is true in deps.config.
 * Returns null when rescue is disabled or abstention was not detected.
 */
// fallow-ignore-next-line unused-export
export async function performRescueSearch(
  deps: MemoryServiceDeps,
  opts: RescueSearchOptions,
): Promise<Pick<RetrievalResult, 'injectionText' | 'specialistAnswer'> | null> {
  if (!deps.config.abstentionRescueEnabled) return null;
  if (!detectAbstention(opts.candidateAnswer)) return null;

  const keywords = extractKeywordsFromQuery(opts.query);
  const augmentedQuery = keywords ? `${opts.query} ${keywords}` : opts.query;
  const rescueK = deps.config.abstentionRescueRetrieveK;
  const rescueResult = await performSearch(deps, {
    userId: opts.userId,
    query: augmentedQuery,
    limit: rescueK,
  });

  const { injectionText: rescueInjection } = rescueResult;
  const mergedInjection = applyConfidencePrefix(
    opts.firstInjectionText + '\n\n' + rescueInjection,
    true,
    {
      adaptive: deps.config.confidencePrefixAdaptiveEnabled,
      questionType: classifyQuestion(opts.query),
    },
  );

  if (!detectAbstention(opts.candidateAnswer)) {
    return { injectionText: mergedInjection };
  }

  const apiKey = deps.config.anthropicApiKey ?? '';
  const sonnetAnswer = await callSonnetRescue(
    { model: deps.config.abstentionRescueSonnetModel, apiKey },
    mergedInjection,
    opts.query,
  );
  return { injectionText: mergedInjection, specialistAnswer: sonnetAnswer || undefined };
}

/**
 * Workspace-scoped search: retrieves memories from the workspace memory pool.
 * Uses workspace-filtered vector search with agent scope and visibility enforcement.
 */
export async function performWorkspaceSearch(
  deps: MemoryServiceDeps,
  userId: string,
  query: string,
  workspace: WorkspaceContext,
  options: {
    agentScope?: AgentScope;
    limit?: number;
    referenceTime?: Date;
    retrievalOptions?: RetrievalOptions;
    sessionId?: string;
  } = {},
): Promise<RetrievalResult> {
  const { limit: effectiveLimit } = resolveSearchLimitDetailed(query, options.limit, deps.config);
  const queryEmbedding = await embedText(query, 'query');

  const memories = await deps.stores.search.searchSimilarInWorkspace(
    workspace.workspaceId, queryEmbedding, effectiveLimit,
    options.agentScope ?? 'all', workspace.agentId, options.referenceTime, options.sessionId,
  );
  const trace = new TraceCollector(query, userId);
  trace.stage('workspace-search', memories, {
    workspaceId: workspace.workspaceId,
    agentId: workspace.agentId,
    agentScope: options.agentScope ?? 'all',
    sessionId: options.sessionId,
  });

  const { filtered: staleFilteredMemories, removedCompositeIds } =
    await excludeStaleComposites(deps.stores.memory, userId, memories);
  if (removedCompositeIds.length > 0) {
    trace.stage('stale-composite-filter', staleFilteredMemories, {
      removedCount: removedCompositeIds.length,
      removedIds: removedCompositeIds,
    });
  }

  const relevanceFilter = applySearchRelevanceFilter(
    staleFilteredMemories,
    trace,
    query,
    options.retrievalOptions,
    deps.config,
  );
  const filteredMemories = relevanceFilter.memories;
  for (const m of filteredMemories) deps.stores.memory.touchMemory(m.id).catch(() => {});

  const mode = options.retrievalOptions?.retrievalMode ?? 'flat';
  const workspaceQuestionType = classifyQuestion(query);
  const rawInjection = buildInjection(filteredMemories, query, mode, options.retrievalOptions?.tokenBudget, undefined, undefined, undefined, undefined, undefined, workspaceQuestionType);
  const wsInjectionText = applyConfidencePrefix(
    rawInjection.injectionText,
    deps.config.abstentionRescueEnabled,
    {
      adaptive: deps.config.confidencePrefixAdaptiveEnabled,
      questionType: workspaceQuestionType,
    },
  );
  const injection = { ...rawInjection, injectionText: wsInjectionText };
  const outputMemories = injection.includedMemories;
  updateRetrievalSummary(trace, outputMemories, query, options.retrievalOptions, relevanceFilter);
  trace.finalize(outputMemories);
  return {
    memories: outputMemories,
    citations: outputMemories.map((m) => m.id),
    retrievalMode: mode,
    retrievalSummary: trace.getRetrievalSummary(),
    ...injection,
  };
}
