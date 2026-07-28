/**
 * Top-level ingest pipeline logic: performIngest, performQuickIngest, performWorkspaceIngest.
 * Delegates AUDN resolution to memory-audn.ts and storage to memory-storage.ts.
 */

import { embedText } from './embedding.js';
import { consensusExtractFacts } from './consensus-extraction.js';
import { quickExtractFacts } from './quick-extraction.js';
import { IngestTraceCollector } from './ingest-trace.js';
import { assessWriteSecurity } from './write-security.js';
import { timed } from './timing.js';
import { runPostWriteProcessors } from './ingest-post-write.js';
import { extractLiteralsFromFact } from './literal-extractor.js';
import { processFactThroughPipeline } from './ingest-fact-pipeline.js';
import { resolveSessionDate } from './session-date.js';
import { maybeRebuildProfileForUser } from './user-profile-builder.js';
import { maybeExtractEntityAttributesForIngest } from './entity-attribute-extractor.js';
import type { MemoryMetadata, StoreMemoryInput, WorkspaceContext } from '../db/repository-types.js';
import type {
  IngestResult,
  EntropyContext,
  FactInput,
  FactResult,
  MemoryServiceDeps,
} from './memory-service-types.js';
import type { ReflectionJobsRepository } from '../db/reflection-jobs-repository.js';
import { recordCloudTraceOperation } from './cloud-trace-sync.js';

/** Enqueue a reflection job for (userId, conversationId) when the feature gate is on. */
async function maybeEnqueueReflectionJob(
  reflectionJobs: ReflectionJobsRepository | undefined,
  reflectEnabled: boolean | undefined,
  userId: string,
  conversationId: string,
): Promise<void> {
  if (!reflectEnabled || !reflectionJobs) return;
  try {
    await reflectionJobs.enqueue(userId, conversationId);
  } catch (e) {
    // Enqueue failure must NEVER block the ingest response.
    console.error('[memory-ingest] reflection enqueue failed:', e);
  }
}

/** Mutable accumulators shared across ingest loops. */
interface IngestAccumulator {
  counters: Record<string, number>;
  storedMemoryIds: string[];
  updatedMemoryIds: string[];
  memoryIds: string[];
  embeddingCache: Map<string, number[]>;
}

function createIngestAccumulator(): IngestAccumulator {
  return {
    counters: { stored: 0, updated: 0, deleted: 0, skipped: 0, preserved_contradiction: 0 },
    storedMemoryIds: [],
    updatedMemoryIds: [],
    memoryIds: [],
    embeddingCache: new Map(),
  };
}

/** Record a single fact result into the accumulator. */
function accumulateFactResult(acc: IngestAccumulator, result: FactResult): void {
  if (result.memoryId) {
    acc.memoryIds.push(result.memoryId);
    if (result.outcome === 'stored') acc.storedMemoryIds.push(result.memoryId);
    else if (result.outcome === 'updated') acc.updatedMemoryIds.push(result.memoryId);
    // BEAM CR fix: bilateral preservation keeps both sides — the returned
    // memoryId is the NEW row (the existing counterpart already lives in
    // memories). Treat as "stored" for downstream linking/processing.
    else if (result.outcome === 'preserved_contradiction') acc.storedMemoryIds.push(result.memoryId);
    if (result.embedding) acc.embeddingCache.set(result.memoryId, result.embedding);
  }
  acc.counters[result.outcome]++;
}

function buildIngestResult(episodeId: string, factsCount: number, acc: IngestAccumulator, linksCreated: number, compositesCreated: number): IngestResult {
  return {
    episodeId, factsExtracted: factsCount,
    memoriesStored: acc.counters.stored, memoriesUpdated: acc.counters.updated,
    memoriesDeleted: acc.counters.deleted, memoriesSkipped: acc.counters.skipped,
    storedMemoryIds: acc.storedMemoryIds, updatedMemoryIds: acc.updatedMemoryIds,
    memoryIds: acc.memoryIds, linksCreated, compositesCreated,
  };
}

function finalizeIngestResult(
  deps: MemoryServiceDeps,
  ingestStart: number,
  episodeId: string,
  factsCount: number,
  acc: IngestAccumulator,
  linksCreated: number,
  compositesCreated: number,
  traceCollector: IngestTraceCollector,
  traceMetadata: Parameters<IngestTraceCollector['finalize']>[0],
): IngestResult {
  const result = {
    ...buildIngestResult(episodeId, factsCount, acc, linksCreated, compositesCreated),
    ingestTraceId: traceCollector.finalize(traceMetadata),
  };
  recordCloudTraceOperation(
    deps.stores.pool,
    deps.config.cloudTraceSync,
    deps.config.cloudTraceSync?.instanceId,
    {
      operation: 'memory.ingest',
      durationMs: performance.now() - ingestStart,
      userId: traceMetadata.userId,
      summary: {
        operation_detail: `${traceMetadata.mode} ingest (${factsCount} fact(s))`,
        result_count: acc.counters.stored + acc.counters.updated,
        episode_id: episodeId,
        memories_stored: acc.counters.stored,
        memories_updated: acc.counters.updated,
        memories_deleted: acc.counters.deleted,
      },
      evidence: { mode: traceMetadata.mode, source_site: traceMetadata.sourceSite },
    },
  );
  return result;
}

/** Full consensus-based ingest pipeline. */
/**
 * Persisted in `episodes.content` in place of the raw transcript when the
 * deployment runs RAW_CONTENT_POLICY=reject and the caller did not stamp a
 * non-raw `content_class`. Extraction still runs against the real transcript
 * transiently; only the durable raw copy is withheld.
 */
const RAW_INPUT_OMITTED_MARKER =
  '[raw input omitted by RAW_CONTENT_POLICY=reject]';

export async function performIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  sessionTimestamp?: Date,
  sessionId?: string,
  redactRawInput: boolean = false,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await timed('ingest.store-episode', () => deps.stores.episode.storeEpisode({ userId, content: redactRawInput ? RAW_INPUT_OMITTED_MARKER : conversationText, sourceSite, sourceUrl, sessionId }));
  const facts = await timed('ingest.extract', () => consensusExtractFacts(conversationText, deps.config));
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();
  const supersededTargets = new Set<string>();
  const entropyCtx: EntropyContext = { seenEntities: new Set(), previousEmbedding: null };
  const storedFacts: Array<{ memoryId: string; fact: FactInput }> = [];

  for (const fact of facts) {
    const result = await timed('ingest.fact', () => processFactThroughPipeline(
      deps, userId, fact, sourceSite, sourceUrl, episodeId,
      { entropyGate: true, fullAudn: true, supersededTargets, entropyCtx, logicalTimestamp: logicalSessionTimestamp, timingPrefix: 'ingest', traceCollector },
    ));
    accumulateFactResult(acc, result);
    if (result.memoryId) storedFacts.push({ memoryId: result.memoryId, fact });
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts,
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: deps.config.compositeGroupingEnabled,
    timingPrefix: 'ingest',
    chunkText: conversationText,
  });

  // Phase 2: literal extraction for IE/KU specialist.
  // Awaited so the container doesn't exit before writes complete.
  // Per-fact failures are logged and never block subsequent facts or the response.
  if (deps.config.phase2SpecialistsEnabled && deps.stores.entityValues) {
    const entityValues = deps.stores.entityValues;
    const model = deps.config.llmModel;
    await Promise.allSettled(
      acc.storedMemoryIds.map(async (memoryId) => {
        const stored = storedFacts.find((sf) => sf.memoryId === memoryId);
        if (!stored) return;
        try {
          await extractLiteralsFromFact(
            { values: entityValues, model },
            {
              userId,
              factId: memoryId,
              factText: stored.fact.fact,
              observedAt: logicalSessionTimestamp ?? new Date(),
            },
          );
        } catch (e) {
          console.error('[literal-extractor] extraction failed for fact', memoryId, e);
        }
      }),
    );
  }

  if (deps.config.userProfileChannelEnabled) {
    void maybeRebuildProfileForUser(deps, userId, acc.storedMemoryIds);
  }
  if (deps.config.entityAttributesEnabled) {
    void maybeExtractEntityAttributesForIngest(
      deps, userId, conversationText, logicalSessionTimestamp, acc.storedMemoryIds,
    );
  }

  await maybeEnqueueReflectionJob(deps.reflectionJobs, deps.reflectEnabled, userId, episodeId);
  console.log(`[timing] ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${facts.length} facts, ${postWrite.compositesCreated} composites, topic=${postWrite.topicAbstractionApplied})`);
  return finalizeIngestResult(
    deps,
    ingestStart,
    episodeId,
    facts.length,
    acc,
    postWrite.linksCreated,
    postWrite.compositesCreated,
    traceCollector,
    { mode: 'full', userId, sourceSite, sourceUrl, episodeId, factsExtracted: facts.length },
  );
}

/**
 * Fast ingest path for UC2 (background capture).
 * Uses rule-based extraction (~50ms) instead of LLM consensus (~22s).
 */
export async function performQuickIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  sessionTimestamp?: Date,
  sessionId?: string,
  redactRawInput: boolean = false,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await deps.stores.episode.storeEpisode({ userId, content: redactRawInput ? RAW_INPUT_OMITTED_MARKER : conversationText, sourceSite, sourceUrl, sessionId });
  const facts = timed('quick-ingest.extract', () => Promise.resolve(quickExtractFacts(conversationText)));
  const extractedFacts = await facts;
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();

  for (const fact of extractedFacts) {
    const result = await timed('quick-ingest.fact', () => processFactThroughPipeline(
      deps, userId, fact, sourceSite, sourceUrl, episodeId,
      { entropyGate: false, fullAudn: false, supersededTargets: new Set(), entropyCtx: { seenEntities: new Set(), previousEmbedding: null }, logicalTimestamp: logicalSessionTimestamp, timingPrefix: 'quick-ingest', traceCollector },
    ));
    accumulateFactResult(acc, result);
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts: [],
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: false,
    timingPrefix: 'quick-ingest',
    chunkText: conversationText,
  });

  console.log(`[timing] quick-ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${extractedFacts.length} facts, ${acc.counters.stored} stored, ${acc.counters.skipped} skipped)`);
  return finalizeIngestResult(
    deps,
    ingestStart,
    episodeId,
    extractedFacts.length,
    acc,
    postWrite.linksCreated,
    0,
    traceCollector,
    { mode: 'quick', userId, sourceSite, sourceUrl, episodeId, factsExtracted: extractedFacts.length },
  );
}

/** Fixed importance assigned to every verbatim-stored memory (no extraction signal to score on). */
const VERBATIM_IMPORTANCE = 0.5;

/** Trust score applied when write-security blocks the content but the verbatim store still persists it. */
const VERBATIM_BLOCKED_TRUST = 0.5;

/**
 * Read the caller-owned `metadata.externalId` if it is a non-empty string.
 * `externalId` is the stable client-side id (the caller's own id) used to
 * make verbatim ingest idempotent. Anything that is not a non-empty string is
 * treated as absent — those rows keep plain insert behavior.
 */
function readExternalId(metadata: MemoryMetadata | undefined): string | undefined {
  const raw = metadata?.externalId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Store content as a single memory without fact extraction.
 * Used for user-created contexts (text/file uploads) where
 * the content should remain as one canonical memory record.
 *
 * Idempotency: when `metadata.externalId` is present, the
 * verbatim store is idempotent on `(user_id, metadata->>'externalId')` over
 * LIVE rows. Re-ingesting the same `externalId` UPDATEs the existing live
 * row's content/embedding/metadata in place (check-then-update) instead of
 * inserting a second row, so `GET /v1/memories/by-external-id/:externalId`
 * resolves deterministically to a single row. A partial unique index over
 * live rows (migration 0002) enforces this at the schema level. Rows WITHOUT
 * an `externalId` keep plain insert behavior and are not constrained.
 */
export async function performStoreVerbatim(
  deps: MemoryServiceDeps,
  userId: string,
  content: string,
  sourceSite: string,
  sourceUrl: string = '',
  metadata?: MemoryMetadata,
  sessionId?: string,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const episodeId = await deps.stores.episode.storeEpisode({ userId, content, sourceSite, sourceUrl, sessionId });
  const embedding = await embedText(content);
  const writeSecurity = assessWriteSecurity(content, sourceSite, deps.config);
  const trustScore = writeSecurity.allowed ? writeSecurity.trust.score : VERBATIM_BLOCKED_TRUST;
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);

  const externalId = readExternalId(metadata);
  const { memoryId, isUpdate } = await writeVerbatimMemory(deps, userId, externalId, {
    userId,
    content,
    embedding,
    memoryType: 'semantic',
    importance: VERBATIM_IMPORTANCE,
    sourceSite,
    sourceUrl,
    episodeId,
    status: 'active',
    keywords: '',
    summary: content.slice(0, 200),
    trustScore,
    metadata,
  });

  traceCollector.record({
    factText: content,
    headline: content.slice(0, 80),
    factType: 'verbatim',
    importance: VERBATIM_IMPORTANCE,
    writeSecurity: {
      allowed: writeSecurity.allowed,
      blockedBy: writeSecurity.blockedBy,
      trustScore: writeSecurity.trust.score,
    },
    decision: {
      source: 'verbatim',
      action: isUpdate ? 'UPDATE' : 'ADD',
      reasonCode: isUpdate ? 'verbatim-dedup-update' : 'verbatim-store',
      targetMemoryId: isUpdate ? memoryId : null,
    },
    outcome: 'stored',
    memoryId,
  });

  const result: IngestResult = {
    episodeId,
    factsExtracted: 1,
    memoriesStored: isUpdate ? 0 : 1,
    memoriesUpdated: isUpdate ? 1 : 0,
    memoriesDeleted: 0,
    memoriesSkipped: 0,
    storedMemoryIds: isUpdate ? [] : [memoryId],
    updatedMemoryIds: isUpdate ? [memoryId] : [],
    memoryIds: [memoryId],
    linksCreated: 0,
    compositesCreated: 0,
    ingestTraceId: traceCollector.finalize({ mode: 'verbatim', userId, sourceSite, sourceUrl, episodeId, factsExtracted: 1 }),
  };
  recordCloudTraceOperation(
    deps.stores.pool,
    deps.config.cloudTraceSync,
    deps.config.cloudTraceSync?.instanceId,
    {
      operation: isUpdate ? 'memory.update' : 'memory.ingest',
      durationMs: performance.now() - ingestStart,
      userId,
      summary: {
        content_len: content.length,
        new_memory_id: memoryId,
        previous_memory_id: isUpdate ? memoryId : undefined,
      },
      evidence: { mode: 'verbatim', source_site: sourceSite },
    },
  );
  return result;
}

/**
 * Update the existing live verbatim row in place for an idempotent
 * re-ingest: refresh content/embedding/trust, then merge caller metadata
 * (JSONB `||`, preserving `externalId`). Returns the row id.
 */
/** Postgres unique-violation, SQLSTATE 23505. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Idempotent verbatim write keyed by external id. Updates the existing row for
 * the external id when one is present, otherwise inserts. Handles the concurrent
 * re-ingest race: when two requests for the same external id both observe no
 * existing row, the partial-unique index makes one insert fail with a unique
 * violation (23505); the loser re-reads the winner's row and updates it, so the
 * call stays idempotent instead of surfacing a 500. Non-unique-violation errors
 * (and a missing externalId) propagate unchanged.
 */
async function writeVerbatimMemory(
  deps: MemoryServiceDeps,
  userId: string,
  externalId: string | undefined,
  storeArgs: StoreMemoryInput & { trustScore: number },
): Promise<{ memoryId: string; isUpdate: boolean }> {
  const existing = externalId ? await deps.stores.memory.getMemoryByExternalId(userId, externalId) : null;
  if (existing) {
    return { memoryId: await applyVerbatimUpdate(deps, userId, existing.id, storeArgs.content, storeArgs.embedding, storeArgs.trustScore, storeArgs.metadata), isUpdate: true };
  }
  try {
    return { memoryId: await deps.stores.memory.storeMemory(storeArgs), isUpdate: false };
  } catch (e) {
    if (!externalId || !isUniqueViolation(e)) throw e;
    const raced = await deps.stores.memory.getMemoryByExternalId(userId, externalId);
    if (!raced) throw e;
    return { memoryId: await applyVerbatimUpdate(deps, userId, raced.id, storeArgs.content, storeArgs.embedding, storeArgs.trustScore, storeArgs.metadata), isUpdate: true };
  }
}

async function applyVerbatimUpdate(
  deps: MemoryServiceDeps,
  userId: string,
  memoryId: string,
  content: string,
  embedding: number[],
  trustScore: number,
  metadata: MemoryMetadata | undefined,
): Promise<string> {
  await deps.stores.memory.updateMemoryContent(
    userId,
    memoryId,
    content,
    embedding,
    VERBATIM_IMPORTANCE,
    '',
    trustScore,
  );
  if (metadata) {
    await deps.stores.memory.updateMemoryMetadata(userId, memoryId, metadata);
  }
  return memoryId;
}

/** Workspace-scoped ingest: stores memories tagged with workspace_id and agent_id. */
export async function performWorkspaceIngest(
  deps: MemoryServiceDeps,
  userId: string,
  conversationText: string,
  sourceSite: string,
  sourceUrl: string = '',
  workspace: WorkspaceContext,
  sessionTimestamp?: Date,
  sessionId?: string,
  redactRawInput: boolean = false,
): Promise<IngestResult> {
  const ingestStart = performance.now();
  const logicalSessionTimestamp = resolveSessionDate(sessionTimestamp, conversationText);
  const episodeId = await timed('ws-ingest.store-episode', () =>
    deps.stores.episode.storeEpisode({
      userId, content: redactRawInput ? RAW_INPUT_OMITTED_MARKER : conversationText, sourceSite, sourceUrl,
      sessionId,
      workspaceId: workspace.workspaceId, agentId: workspace.agentId,
    }),
  );
  const facts = await timed('ws-ingest.extract', () => consensusExtractFacts(conversationText, deps.config));
  const traceCollector = new IngestTraceCollector(deps.config.ingestTraceEnabled);
  const acc = createIngestAccumulator();
  const supersededTargets = new Set<string>();
  const entropyCtx: EntropyContext = { seenEntities: new Set(), previousEmbedding: null };

  for (const fact of facts) {
    const result = await timed('ws-ingest.fact', () =>
      processFactThroughPipeline(deps, userId, fact, sourceSite, sourceUrl, episodeId,
        {
          workspace,
          entropyGate: false,
          fullAudn: true,
          supersededTargets,
          entropyCtx,
          logicalTimestamp: logicalSessionTimestamp,
          timingPrefix: 'ws-ingest',
          traceCollector,
        }),
    );
    accumulateFactResult(acc, result);
  }

  const postWrite = await runPostWriteProcessors(deps, userId, {
    episodeId, sourceSite, sourceUrl, storedFacts: [],
    memoryIds: acc.memoryIds, embeddingCache: acc.embeddingCache,
    sessionTimestamp: logicalSessionTimestamp, compositesEnabled: false,
    timingPrefix: 'ws-ingest',
    chunkText: conversationText,
  });

  console.log(`[timing] ws-ingest.total: ${(performance.now() - ingestStart).toFixed(1)}ms (${facts.length} facts, workspace=${workspace.workspaceId})`);
  return finalizeIngestResult(
    deps,
    ingestStart,
    episodeId,
    facts.length,
    acc,
    postWrite.linksCreated,
    0,
    traceCollector,
    { mode: 'workspace', userId, sourceSite, sourceUrl, episodeId, factsExtracted: facts.length },
  );
}
