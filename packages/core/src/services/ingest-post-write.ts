/**
 * Post-write processors for the ingest pipeline.
 *
 * Runs after the per-fact loop completes: backdates memories to a session
 * timestamp, generates inter-memory links, and clusters related facts
 * into composite memories. Each processor is independently skippable via
 * the batch context.
 *
 * Composite generation is full-ingest-only. The caller controls this via
 * the `compositesEnabled` field — only `performIngest` sets it to true.
 */

import { generateLinks } from './search-pipeline.js';
import { buildComposites, type CompositeInput } from './composite-grouping.js';
import { inferNamespace, deriveMajorityNamespace } from './namespace-retrieval.js';
import { timed } from './timing.js';
import type { FactInput, MemoryServiceDeps } from './memory-service-types.js';
import { extractTopicAbstraction, TopicAbstractionError } from './topic-abstraction.js';
import { embedText } from './embedding.js';
import { updateMemoryTopicAbstraction } from '../db/repository-write.js';
import { maybeBuildRecapsForUser } from './recap-builder.js';

/** Everything the post-write processors need from the completed fact loop. */
export interface PostWriteBatchContext {
  episodeId: string;
  sourceSite: string;
  sourceUrl: string;
  /** Facts that were actually stored (with their memoryIds). Only populated by performIngest. */
  storedFacts: Array<{ memoryId: string; fact: FactInput }>;
  /** All memory IDs produced by the fact loop (stored + updated). */
  memoryIds: string[];
  /** Embedding cache keyed by memoryId, populated during the fact loop. */
  embeddingCache: Map<string, number[]>;
  /** When set, memories are backdated to this timestamp. */
  sessionTimestamp?: Date;
  /** Caller controls this. Only performIngest sets true. */
  compositesEnabled: boolean;
  /** Timing label prefix for timed() wrappers. */
  timingPrefix: string;
  /**
   * Original conversation chunk text. Required when topicAbstractionEnabled
   * is true; the topic-abstraction processor extracts a conceptual topic from
   * the full chunk (one LLM call per chunk, not per fact) and tags every
   * stored memory from this chunk with the same topic + topic_embedding.
   */
  chunkText?: string;
}

export interface PostWriteResult {
  linksCreated: number;
  compositesCreated: number;
  topicAbstractionApplied: boolean;
}

/**
 * Run all post-write processors for a completed ingest batch.
 * Order: backdate → links → composites (if caller-enabled).
 */
export async function runPostWriteProcessors(
  deps: MemoryServiceDeps,
  userId: string,
  ctx: PostWriteBatchContext,
): Promise<PostWriteResult> {
  if (ctx.sessionTimestamp && ctx.memoryIds.length > 0) {
    await timed(`${ctx.timingPrefix}.backdate`, () =>
      deps.stores.memory.backdateMemories(ctx.memoryIds, ctx.sessionTimestamp!),
    );
  }

  const linksCreated = await timed(
    `${ctx.timingPrefix}.links`,
    () => generateLinks(
      { search: deps.stores.search, link: deps.stores.link, memory: deps.stores.memory, entity: deps.stores.entity, summaries: deps.stores.summaries, pool: deps.stores.pool },
      userId, ctx.memoryIds, ctx.embeddingCache, deps.config,
    ),
  );

  let compositesCreated = 0;
  if (ctx.compositesEnabled && ctx.storedFacts.length >= deps.config.compositeMinClusterSize) {
    compositesCreated = await timed(`${ctx.timingPrefix}.composites`, () =>
      generateAndStoreComposites(
        deps,
        userId,
        ctx.storedFacts,
        ctx.embeddingCache,
        ctx.sourceSite,
        ctx.sourceUrl,
        ctx.episodeId,
        ctx.sessionTimestamp,
      ),
    );
  }

  let topicAbstractionApplied = false;
  if (deps.config.topicAbstractionEnabled && ctx.memoryIds.length > 0 && ctx.chunkText) {
    topicAbstractionApplied = await timed(`${ctx.timingPrefix}.topic-abstraction`, () =>
      generateAndStoreTopicAbstraction(deps, userId, ctx.chunkText!, ctx.memoryIds),
    );
  }

  // Recap layer trigger: fire-and-forget background pass. Latency is only
  // measured on ingest if the cluster threshold is met AND the synthesis
  // happens to land synchronously; we deliberately don't await here so the
  // ingest response isn't gated on episode-style consolidation.
  if (deps.config.recapLayerEnabled && ctx.memoryIds.length > 0) {
    void maybeBuildRecapsForUser(deps, userId).catch((err) => {
      console.warn(`[recap] background trigger failed for user=${userId}: ${(err as Error).message}`);
    });
  }

  return { linksCreated, compositesCreated, topicAbstractionApplied };
}

/**
 * Extract a conceptual topic from the chunk, embed it, and tag every memory
 * stored from this chunk with the topic + embedding. One LLM call per chunk.
 *
 * Fail-soft: if topic extraction or embedding throws, the post-write step is
 * skipped (logged) and other processors continue. The memories themselves are
 * already stored — topic_abstraction defaults to '' and topic_embedding to
 * NULL on those rows, which excludes them from the topic-search RRF arm
 * without breaking other retrieval paths.
 */
async function generateAndStoreTopicAbstraction(
  deps: MemoryServiceDeps,
  userId: string,
  chunkText: string,
  memoryIds: string[],
): Promise<boolean> {
  try {
    const { topic } = await extractTopicAbstraction(chunkText, '');
    const embedding = await embedText(topic, 'document');
    await updateMemoryTopicAbstraction(deps.stores.pool, userId, memoryIds, topic, embedding);
    return true;
  } catch (err) {
    if (err instanceof TopicAbstractionError) {
      console.warn(`[topic-abstraction] skipped for ${memoryIds.length} memories: ${err.message}`);
      return false;
    }
    throw err;
  }
}

/** Generate composite memories by clustering related facts from a single episode. */
async function generateAndStoreComposites(
  deps: MemoryServiceDeps,
  userId: string,
  storedFacts: Array<{ memoryId: string; fact: FactInput }>,
  embeddingCache: Map<string, number[]>,
  sourceSite: string,
  sourceUrl: string,
  episodeId: string,
  sessionTimestamp?: Date,
): Promise<number> {
  const memberNamespaceMap = new Map<string, string | null>();
  const compositeInputs: CompositeInput[] = storedFacts
    .filter((sf) => embeddingCache.has(sf.memoryId))
    .map((sf) => {
      const ns = inferNamespace(sf.fact.fact, sourceSite, sf.fact.keywords);
      memberNamespaceMap.set(sf.memoryId, ns);
      return {
        memoryId: sf.memoryId,
        content: sf.fact.fact,
        embedding: embeddingCache.get(sf.memoryId)!,
        importance: sf.fact.importance,
        keywords: sf.fact.keywords,
        headline: sf.fact.headline,
      };
    });

  const composites = buildComposites(compositeInputs);
  if (composites.length === 0) return 0;

  for (const composite of composites) {
    const memberNamespaces = composite.memberMemoryIds.map((id) => memberNamespaceMap.get(id) ?? null);
    const namespace = deriveMajorityNamespace(memberNamespaces);

    await deps.stores.memory.storeMemory({
      userId,
      content: composite.content,
      embedding: composite.embedding,
      memoryType: 'composite',
      importance: composite.importance,
      sourceSite, sourceUrl, episodeId,
      keywords: composite.keywords.join(' '),
      summary: composite.headline,
      overview: composite.overview,
      trustScore: 1.0,
      createdAt: sessionTimestamp,
      observedAt: sessionTimestamp,
      namespace: namespace ?? undefined,
      metadata: {
        memberMemoryIds: composite.memberMemoryIds,
        compositeVersion: 1,
      },
    });
  }

  return composites.length;
}
