/**
 * Shared Zod schema fragments for memory search responses.
 *
 * Keeping these pieces outside `responses.ts` prevents the route-wide schema
 * catalog from accumulating every search-specific observability detail.
 */

import { z } from './zod-setup.js';
import { IsoDateString, NumberOrNaN } from './response-scalars.js';

export const SearchMemoryItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  similarity: NumberOrNaN.optional(),
  score: NumberOrNaN.optional(),
  semantic_similarity: NumberOrNaN.optional(),
  ranking_score: NumberOrNaN.optional().openapi({
    description: 'Composite ranking/debug score. It is not normalized and may be outside the [0,1] relevance range.',
  }),
  relevance: NumberOrNaN.optional().openapi({
    description: 'Normalized relevance value used for threshold filtering; clamped to the [0,1] range.',
  }),
  importance: NumberOrNaN.optional(),
  source_site: z.string().optional(),
  created_at: IsoDateString.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().openapi({
    description:
      'Memory metadata persisted on the row, including caller-supplied ' +
      'verbatim metadata (set via /v1/memories/ingest/quick with ' +
      'skip_extraction=true) and core-generated metadata (e.g. cmo_id, ' +
      'memberMemoryIds, headline). Mirrors the shape /v1/memories/list ' +
      'and /v1/memories/:id return.',
  }),
}).openapi({ description: 'Projected memory record in a search result.' });

export const TierAssignmentSchema = z.object({
  memory_id: z.string(),
  tier: z.string(),
  estimated_tokens: z.number(),
});

export const LessonCheckSchema = z.object({
  safe: z.boolean(),
  warnings: z.array(z.unknown()),
  highest_severity: z.string(),
  matched_count: z.number(),
});

export const ConsensusResponseSchema = z.object({
  original_count: z.number(),
  filtered_count: z.number(),
  removed_count: z.number(),
  removed_memory_ids: z.array(z.string()),
});

const RetrievalTraceSchema = z.object({
  candidate_ids: z.array(z.string()),
  candidate_count: z.number(),
  query_text: z.string(),
  skip_repair: z.boolean(),
  relevance_threshold: z.number().nullable().optional(),
  relevance_filter_source: z.string().optional(),
  relevance_filter_reason: z.string().optional(),
  filtered_candidate_ids: z.array(z.string()).optional(),
  filter_decisions: z.array(z.object({
    id: z.string(),
    source_site: z.string(),
    source_kind: z.enum(['integration', 'local']),
    namespace: z.string().nullable(),
    semantic_similarity: z.number(),
    ranking_score: z.number().openapi({
      description: 'Composite ranking/debug score. It is not normalized and may be outside the [0,1] relevance range.',
    }),
    relevance: z.number().openapi({
      description: 'Normalized relevance value used for threshold filtering; clamped to the [0,1] range.',
    }),
    threshold: z.number().nullable(),
    decision: z.enum(['kept', 'filtered']),
    reason: z.string(),
  })).optional().openapi({
    description:
      'Per-candidate threshold decisions emitted only when retrieval tracing is enabled. ' +
      'Entries include per-result source_site, source_kind, and namespace for debugging disclosure scope.',
  }),
  trace_id: z.string().optional(),
  stage_count: z.number().optional(),
  stage_names: z.array(z.string()).optional(),
});

const PackagingTraceSchema = z.object({
  package_type: z.enum(['subject-pack', 'timeline-pack', 'tiered']),
  included_ids: z.array(z.string()),
  dropped_ids: z.array(z.string()),
  evidence_roles: z.record(z.string(), z.enum(['primary', 'supporting', 'historical', 'contextual'])),
  episode_count: z.number(),
  date_count: z.number(),
  has_current_marker: z.boolean(),
  has_conflict_block: z.boolean(),
  token_cost: z.number(),
});

const AssemblyTraceSchema = z.object({
  final_ids: z.array(z.string()),
  final_token_cost: z.number(),
  token_budget: z.number().nullable(),
  primary_evidence_position: z.number().nullable(),
  blocks: z.array(z.string()),
});

export const ObservabilityResponseSchema = z.object({
  retrieval: RetrievalTraceSchema.optional(),
  packaging: PackagingTraceSchema.optional(),
  assembly: AssemblyTraceSchema.optional(),
}).openapi({ description: 'Retrieval pipeline trace summaries.' });
