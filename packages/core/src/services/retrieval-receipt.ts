/**
 * Retrieval-receipt finalizer.
 *
 * Stamps an audit-grade `retrievalReceipt` onto every search result and
 * enriches each returned memory row with its owning claim's
 * `current_version_id`. The receipt lets a client log a retrieval as a
 * replay fixture and replay the downstream decision bit-for-bit: it pins
 * the embedding model used for the query vector, the query text, the ranked
 * candidate ordering, and a correlation trace id.
 *
 * Runs exactly once per top-level search (after all packaging/reranking has
 * settled) so the candidate ordering and version stamps reflect the final
 * returned set. Version ids come from a single batched lookup keyed on the
 * final memory ids — never an N+1 per-result round-trip.
 *
 * The embedding identity is sourced from `deps.config` — the per-request
 * effective runtime config that drove this query (honoring config
 * overrides) — not from embedding module global state, so the receipt
 * reflects exactly the model the request was configured to use.
 */

import type { ClaimStore } from '../db/stores.js';
import type { MemoryServiceDeps, RetrievalReceipt, RetrievalResult } from './memory-service-types.js';

type EmbeddingConfig = Pick<
  MemoryServiceDeps['config'],
  'embeddingProvider' | 'embeddingModel' | 'embeddingDimensions' | 'voyageQueryModel'
>;

/**
 * Correlation id for a single retrieval. Opaque (not part of any hash or
 * identity path), so a wall-clock + random suffix is acceptable here; the
 * determinism rules apply to audit/hash derivation, not to this id.
 */
function newTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Resolved query-task model id. Voyage splits query/document models; every
 * other provider uses a single model. No supported provider exposes a
 * separate immutable version string, so the model id is the most precise
 * model identity available — never a fabricated value.
 */
function queryModel(config: EmbeddingConfig): string {
  return config.embeddingProvider === 'voyage' ? config.voyageQueryModel : config.embeddingModel;
}

function buildReceipt(
  config: EmbeddingConfig,
  query: string,
  candidateIds: string[],
  traceId: string,
): RetrievalReceipt {
  const model = queryModel(config);
  return {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: model,
    embeddingModelVersion: model,
    embeddingDimensions: config.embeddingDimensions,
    queryText: query,
    candidateIds,
    traceId,
  };
}

/**
 * Attach the retrieval receipt and stamp `current_version_id` on each
 * returned memory. Reuses the trace id already minted by the search trace
 * when present so the receipt and any emitted observability trace share one
 * correlation id; otherwise mints a fresh one (e.g. lesson-block /
 * URI-resolution early returns that never built a trace summary).
 */
export async function finalizeRetrievalReceipt(
  claimStore: ClaimStore,
  config: EmbeddingConfig,
  userId: string,
  query: string,
  result: RetrievalResult,
): Promise<RetrievalResult> {
  const candidateIds = result.memories.map((memory) => memory.id);
  const versionByMemory = await claimStore.getCurrentVersionIdsByMemoryIds(userId, candidateIds);
  const memories = result.memories.map((memory) => ({
    ...memory,
    current_version_id: versionByMemory.get(memory.id) ?? null,
  }));
  const traceId = result.retrievalSummary?.traceId ?? newTraceId();
  return {
    ...result,
    memories,
    retrievalReceipt: buildReceipt(config, query, candidateIds, traceId),
  };
}
