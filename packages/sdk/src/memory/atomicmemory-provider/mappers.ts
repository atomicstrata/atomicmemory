/**
 * @file Response Mappers for AtomicMemory Provider
 *
 * Maps raw backend JSON responses to V3 types.
 */

import type {
  Memory,
  SearchResult,
  IngestResult,
  MemoryVersion,
  RetrievalReceipt,
  Scope,
} from '../types';
import { MemoryProviderError } from '../errors';

// ---------------------------------------------------------------------------
// Raw backend shapes
// ---------------------------------------------------------------------------

interface RawMemory {
  id: string;
  content: string;
  similarity?: number;
  semantic_similarity?: number;
  score?: number;
  ranking_score?: number;
  relevance?: number;
  importance?: number;
  source_site?: string;
  /** Present on list responses; not on search responses today. */
  source_url?: string;
  /** Present on list responses; dropped from search responses today. */
  episode_id?: string;
  namespace?: string;
  session_id?: string | null;
  created_at?: string;
  /** Per-result retrieval-receipt fields (present on search responses). */
  version_id?: string | null;
  observed_at?: string;
}

/** Raw wire shape of the per-search retrieval receipt (snake_case). */
interface RawRetrievalReceipt {
  embedding_provider?: string;
  embedding_model: string;
  embedding_model_version: string;
  embedding_dimensions: number;
  query_text: string;
  candidate_ids: string[];
  trace_id: string;
}

interface RawAuditEntry {
  id: string;
  content: string;
  created_at: string;
  parent_id?: string;
  event?: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toMemory(raw: RawMemory, scope: Scope): Memory {
  return {
    id: raw.id,
    content: raw.content,
    scope: buildScope(raw, scope),
    createdAt: raw.created_at ? new Date(raw.created_at) : new Date(),
    provenance: buildProvenance(raw),
    metadata: buildMetadata(raw),
  };
}

function buildScope(raw: RawMemory, scope: Scope): Scope {
  if (scope.namespace !== undefined && raw.namespace && raw.namespace !== scope.namespace) {
    throw new Error(
      'atomicmemory-provider: backend response `namespace` did not match requested namespace scope',
    );
  }
  if (scope.thread !== undefined) {
    if (!raw.session_id) {
      throw new Error(
        'atomicmemory-provider: backend response missing required `session_id` for thread-scoped request',
      );
    }
    if (raw.session_id !== scope.thread) {
      throw new Error(
        'atomicmemory-provider: backend response `session_id` did not match requested thread scope',
      );
    }
  }
  return {
    ...scope,
    ...(raw.namespace ? { namespace: raw.namespace } : {}),
    ...(raw.session_id ? { thread: raw.session_id } : {}),
  };
}

/**
 * Both `source_site` and `source_url` are SDK-side `provenance`
 * fields. Returns `undefined` when neither is present so we don't
 * emit empty objects.
 */
function buildProvenance(raw: RawMemory): Memory['provenance'] {
  const provenance: { source?: string; sourceUrl?: string } = {};
  if (raw.source_site !== undefined) provenance.source = raw.source_site;
  if (raw.source_url !== undefined) provenance.sourceUrl = raw.source_url;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/**
 * `metadata` is a free-form record. `importance` was always mapped
 * here; `episodeId` is added because V3 `Memory` has no first-class
 * episode field. Explicit `!== undefined` (not truthiness) so a
 * legitimate `importance: 0` is preserved.
 */
function buildMetadata(raw: RawMemory): Memory['metadata'] {
  const metadata: Record<string, unknown> = {};
  if (raw.importance !== undefined) metadata.importance = raw.importance;
  if (raw.episode_id != null) metadata.episodeId = raw.episode_id;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function toSearchResult(raw: RawMemory, scope: Scope): SearchResult {
  const similarity = raw.semantic_similarity ?? raw.similarity;
  const rankingScore = raw.ranking_score ?? raw.score;
  const relevance = raw.relevance;
  return {
    memory: toMemory(raw, scope),
    score: rankingScore ?? similarity ?? 0,
    ...(similarity !== undefined ? { similarity } : {}),
    ...(rankingScore !== undefined ? { rankingScore } : {}),
    ...(relevance !== undefined ? { relevance } : {}),
    ...(raw.version_id !== undefined ? { versionId: raw.version_id } : {}),
    ...(raw.observed_at !== undefined ? { observedAt: raw.observed_at } : {}),
  };
}

/** Map the snake_case wire retrieval receipt to the camelCase SDK shape. */
export function toRetrievalReceipt(raw: RawRetrievalReceipt): RetrievalReceipt {
  return {
    ...(raw.embedding_provider !== undefined ? { embeddingProvider: raw.embedding_provider } : {}),
    embeddingModel: raw.embedding_model,
    embeddingModelVersion: raw.embedding_model_version,
    embeddingDimensions: raw.embedding_dimensions,
    queryText: raw.query_text,
    candidateIds: raw.candidate_ids,
    traceId: raw.trace_id,
  };
}

/** Require completed-ingest IDs at the shared generic and namespace wire boundary. */
export function assertIngestIds(raw: unknown): asserts raw is {
  stored_memory_ids: string[];
  updated_memory_ids: string[];
} {
  const result = raw as { stored_memory_ids?: unknown; updated_memory_ids?: unknown } | null;
  if (!isMemoryIdList(result?.stored_memory_ids) || !isMemoryIdList(result?.updated_memory_ids)) {
    throw new MemoryProviderError('Invalid ingest response: expected stored and updated memory IDs', 'atomicmemory', 'ingest');
  }
}

/** Map the validated wire IDs to the generic SDK shape. */
export function toIngestResult(raw: unknown): IngestResult {
  assertIngestIds(raw);
  return {
    created: raw.stored_memory_ids,
    updated: raw.updated_memory_ids,
    // The wire reports skipped memories as a count, not an ID array.
    unchanged: [],
  };
}

function isMemoryIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
}

export function toMemoryVersion(raw: RawAuditEntry): MemoryVersion {
  return {
    id: raw.id,
    content: raw.content,
    createdAt: new Date(raw.created_at),
    parentId: raw.parent_id,
    event: mapAuditEvent(raw.event),
  };
}

function mapAuditEvent(
  event?: string
): MemoryVersion['event'] {
  switch (event) {
    case 'created':
    case 'updated':
    case 'superseded':
    case 'invalidated':
      return event;
    default:
      return 'created';
  }
}
