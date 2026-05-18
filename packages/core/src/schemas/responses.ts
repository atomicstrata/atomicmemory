/**
 * @file Zod response schemas for every HTTP route.
 *
 * Mirrors the wire shapes emitted by `src/routes/memory-response-formatters.ts`
 * and inline response literals in `src/routes/memories.ts` + `src/routes/agents.ts`.
 * Feeds the OpenAPI registry so `npm run check:openapi` catches drift
 * between emitted responses and the declared spec.
 *
 * Field naming follows the wire contract (snake_case). DB-row schemas
 * (`MemoryRowSchema`, `LessonRowSchema`, `ClaimVersionRowSchema`,
 * `MemoryConflictRowSchema`) declare the full column set that Express
 * serializes — `Date` columns become ISO strings on the wire.
 */

import { z } from './zod-setup.js';
import { IsoDateString, IsoDateStringOrNull } from './response-scalars.js';

// Document-route response schemas live in a focused module to keep
// this file under the workspace 400 LOC rule. Re-exported below so
// `import * as R from './responses'` callers stay unchanged.
export {
  RawDocumentResponseSchema,
  RegisterDocumentResponseSchema,
  ListDocumentsResponseSchema,
  DocumentListRootResponseSchema,
  DeleteDocumentResponseSchema,
  UploadRawDocumentResponseSchema,
  IndexDocumentResponseSchema,
  DocumentLimitsResponseSchema,
  DocumentFailureMarkerResponseSchema,
} from './document-response-schemas.js';
import {
  ConsensusResponseSchema,
  LessonCheckSchema,
  ObservabilityResponseSchema,
  SearchMemoryItemSchema,
  TierAssignmentSchema,
} from './search-response-parts.js';

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const ScopeResponseSchema = z.union([
  z.object({ kind: z.literal('user'), user_id: z.string() }),
  z.object({
    kind: z.literal('workspace'),
    user_id: z.string(),
    workspace_id: z.string(),
    agent_id: z.string(),
    agent_scope: z.unknown().optional(),
  }),
]).openapi({ description: 'Echoed scope: user-scoped or workspace-scoped.' });

const MemoryRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  content: z.string(),
  embedding: z.array(z.number()),
  memory_type: z.string(),
  importance: z.number(),
  source_site: z.string(),
  source_url: z.string(),
  episode_id: z.string().nullable().optional(),
  status: z.enum(['active', 'needs_clarification']),
  metadata: z.record(z.string(), z.unknown()),
  keywords: z.string(),
  namespace: z.string().nullable().optional(),
  summary: z.string(),
  overview: z.string(),
  trust_score: z.number(),
  observed_at: IsoDateString,
  created_at: IsoDateString,
  last_accessed_at: IsoDateString,
  access_count: z.number(),
  expired_at: IsoDateStringOrNull.optional(),
  deleted_at: IsoDateStringOrNull.optional(),
  network: z.unknown(),
  opinion_confidence: z.number().nullable().optional(),
  observation_subject: z.string().nullable().optional(),
  workspace_id: z.string().nullable().optional(),
  agent_id: z.string().nullable().optional(),
  visibility: z.enum(['agent_only', 'restricted', 'workspace']).nullable().optional(),
}).passthrough().openapi({ description: 'Full memory row as emitted by core.' });

const ClusterCandidateSchema = z.object({
  member_ids: z.array(z.string()),
  member_contents: z.array(z.string()),
  avg_affinity: z.number(),
  member_count: z.number(),
});

const DecayCandidateSchema = z.object({
  id: z.string(),
  content: z.string(),
  retention_score: z.number(),
  importance: z.number(),
  days_since_access: z.number(),
  access_count: z.number(),
});

const LessonRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  lesson_type: z.enum([
    'injection_blocked',
    'false_memory',
    'contradiction_pattern',
    'user_reported',
    'consensus_violation',
    'trust_violation',
  ]),
  pattern: z.string(),
  embedding: z.array(z.number()),
  source_memory_ids: z.array(z.string()),
  source_query: z.string().nullable(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: IsoDateString,
}).passthrough().openapi({ description: 'Lesson row from the repository.' });

const ClaimVersionRowSchema = z.object({
  id: z.string(),
  claim_id: z.string(),
  user_id: z.string(),
  memory_id: z.string().nullable().optional(),
  content: z.string(),
  embedding: z.array(z.number()),
  importance: z.number(),
  source_site: z.string(),
  source_url: z.string(),
  episode_id: z.string().nullable().optional(),
  valid_from: IsoDateString,
  valid_to: IsoDateStringOrNull.optional(),
  superseded_by_version_id: z.string().nullable().optional(),
  mutation_type: z.enum(['add', 'update', 'supersede', 'delete', 'clarify']).nullable().optional(),
  mutation_reason: z.string().nullable().optional(),
  previous_version_id: z.string().nullable().optional(),
  actor_model: z.string().nullable().optional(),
  contradiction_confidence: z.number().nullable().optional(),
  created_at: IsoDateString,
}).passthrough().openapi({ description: 'Claim-version row (one snapshot in a memory\'s history).' });

const MemoryConflictRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  new_memory_id: z.string().nullable(),
  existing_memory_id: z.string().nullable(),
  new_agent_id: z.string().nullable(),
  existing_agent_id: z.string().nullable(),
  new_trust_level: z.number().nullable(),
  existing_trust_level: z.number().nullable(),
  contradiction_confidence: z.number(),
  clarification_note: z.string().nullable(),
  status: z.enum(['open', 'resolved_new', 'resolved_existing', 'resolved_both', 'auto_resolved']),
  resolution_policy: z.string().nullable(),
  resolved_at: IsoDateStringOrNull,
  created_at: IsoDateString,
  auto_resolve_after: IsoDateStringOrNull,
}).passthrough().openapi({ description: 'Memory conflict row from the repository.' });

const HealthConfigResponseSchema = z.object({
  retrieval_profile: z.string(),
  embedding_provider: z.string(),
  embedding_model: z.string(),
  voyage_document_model: z.string(),
  voyage_query_model: z.string(),
  llm_provider: z.string(),
  llm_model: z.string(),
  clarification_conflict_threshold: z.number(),
  max_search_results: z.number(),
  hybrid_search_enabled: z.boolean(),
  iterative_retrieval_enabled: z.boolean(),
  entity_graph_enabled: z.boolean(),
  cross_encoder_enabled: z.boolean(),
  agentic_retrieval_enabled: z.boolean(),
  repair_loop_enabled: z.boolean(),
}).openapi({ description: 'Runtime config snapshot returned by /health + /config.' });

// ---------------------------------------------------------------------------
// Per-route response schemas
// ---------------------------------------------------------------------------

export const IngestResponseSchema = z.object({
  episode_id: z.string(),
  facts_extracted: z.number(),
  memories_stored: z.number(),
  memories_updated: z.number(),
  memories_deleted: z.number(),
  memories_skipped: z.number(),
  stored_memory_ids: z.array(z.string()),
  updated_memory_ids: z.array(z.string()),
  links_created: z.number(),
  composites_created: z.number(),
  ingest_trace_id: z.string().optional(),
}).openapi({ description: 'Ingest result: extraction counts + stored/updated memory IDs.' });

export const SearchResponseSchema = z.object({
  count: z.number(),
  retrieval_mode: z.enum(['flat', 'tiered', 'abstract-aware']),
  scope: ScopeResponseSchema,
  memories: z.array(SearchMemoryItemSchema),
  injection_text: z.string().optional(),
  citations: z.array(z.string()).optional(),
  budget_constrained: z.boolean(),
  tier_assignments: z.array(TierAssignmentSchema).optional(),
  expand_ids: z.array(z.string()).optional(),
  estimated_context_tokens: z.number().optional(),
  lesson_check: LessonCheckSchema.optional(),
  consensus: ConsensusResponseSchema.optional(),
  observability: ObservabilityResponseSchema.optional(),
  /**
   * Phase 2 specialist answer. Present when a Phase 2 specialist handled the
   * query. Callers that understand this field should return it directly to the
   * user without an additional LLM pass — it is the literal answer produced
   * by CR/TR/MSR/IE-KU specialist logic.
   */
  specialist_answer: z.string().optional(),
}).openapi({ description: 'Search results with injection_text, citations, budget_constrained, and optional traces.' });

export const ExpandResponseSchema = z.object({
  memories: z.array(MemoryRowSchema),
}).openapi({ description: 'Expanded memory rows for the requested IDs.' });

export const VerifyResponseSchema = z.object({
  verified_answer: z.string(),
  changed: z.boolean(),
}).openapi({
  description:
    'Verifier-pass result. `verified_answer` is the candidate answer unchanged if grounded, or rewritten to drop unsupported specifics. `changed` is true when the answer was rewritten.',
});

export const ListResponseSchema = z.object({
  memories: z.array(MemoryRowSchema),
  count: z.number(),
}).openapi({ description: 'Paginated memory list.' });

export const GetMemoryResponseSchema = MemoryRowSchema;

export const StatsResponseSchema = z.object({
  count: z.number(),
  avg_importance: z.number(),
  source_distribution: z.record(z.string(), z.number()),
}).openapi({ description: 'Aggregate memory stats for a user.' });

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  config: HealthConfigResponseSchema,
}).openapi({ description: 'Health + runtime config snapshot.' });

export const ConfigUpdateResponseSchema = z.object({
  applied: z.array(z.string()),
  config: HealthConfigResponseSchema,
  note: z.string(),
}).openapi({ description: 'Applied config updates + full post-update snapshot.' });

const ConsolidateScanResponseSchema = z.object({
  memories_scanned: z.number(),
  clusters_found: z.number(),
  memories_in_clusters: z.number(),
  clusters: z.array(ClusterCandidateSchema),
}).openapi({ description: 'Consolidation dry-run (execute=false).' });

const ConsolidateExecuteResponseSchema = z.object({
  clusters_consolidated: z.number(),
  memories_archived: z.number(),
  memories_created: z.number(),
  consolidated_memory_ids: z.array(z.string()),
}).openapi({ description: 'Consolidation execution result (execute=true).' });

export const ConsolidateResponseSchema = z.union([
  ConsolidateScanResponseSchema,
  ConsolidateExecuteResponseSchema,
]).openapi({ description: 'Consolidation result — scan or execute.' });

export const FirstMentionsExtractResponseSchema = z.object({
  events: z.array(z.object({
    topic: z.string(),
    turn_id: z.number(),
    memory_id: z.string(),
    anchor_date: z.string().nullable(),
    position_in_conversation: z.number(),
  })),
}).openapi({ description: 'Extracted first-mention events for a conversation.' });

export const EventChainsResponseSchema = z.object({
  chains: z.array(z.object({
    entity_id: z.string(),
    events: z.array(z.object({
      memory_id: z.string(),
      content: z.string(),
      observation_date: z.string(),
      position_in_chain: z.number(),
      predecessor_memory_id: z.string().nullable(),
    })),
  })),
}).openapi({ description: 'Per-entity chronological event chains from the Temporal Linkage List.' });

export const DecayResponseSchema = z.object({
  memories_evaluated: z.number(),
  candidates_for_archival: z.array(DecayCandidateSchema),
  retention_threshold: z.number(),
  avg_retention_score: z.number(),
  archived: z.number(),
}).openapi({ description: 'Decay evaluation (+ archive count when not dry-run).' });

export const CapResponseSchema = z.object({
  active_memories: z.number(),
  max_memories: z.number(),
  status: z.enum(['ok', 'warn', 'exceeded']),
  usage_ratio: z.number(),
  recommendation: z.enum(['none', 'consolidate', 'decay', 'consolidate-and-decay']),
}).openapi({ description: 'Memory cap status and recommendation.' });

export const LessonsListResponseSchema = z.object({
  lessons: z.array(LessonRowSchema),
  count: z.number(),
}).openapi({ description: 'Active lessons for a user.' });

export const LessonStatsResponseSchema = z.object({
  total_active: z.number(),
  by_type: z.record(z.string(), z.number()),
}).openapi({ description: 'Aggregate lesson counts by type.' });

export const LessonReportResponseSchema = z.object({
  lesson_id: z.string(),
}).openapi({ description: 'ID of the newly-reported lesson.' });

export const ReconciliationResponseSchema = z.object({
  processed: z.number(),
  resolved: z.number(),
  noops: z.number(),
  updates: z.number(),
  supersedes: z.number(),
  deletes: z.number(),
  adds: z.number(),
  errors: z.number(),
  duration_ms: z.number(),
}).openapi({ description: 'Deferred-AUDN reconciliation counters.' });

export const ReconcileStatusResponseSchema = z.object({
  pending: z.number(),
  enabled: z.boolean(),
}).passthrough().openapi({ description: 'Current deferred-AUDN queue state.' });

export const ResetSourceResponseSchema = z.object({
  success: z.literal(true),
  deleted_memories: z.number(),
  deleted_episodes: z.number(),
  deleted_documents: z.number(),
}).openapi({ description: 'Reset-by-source deletion counts.' });

export const SuccessResponseSchema = z.object({ success: z.literal(true) })
  .openapi({ description: 'Successful no-payload operation.' });

export const MutationSummaryResponseSchema = z.object({
  total_versions: z.number(),
  active_versions: z.number(),
  superseded_versions: z.number(),
  total_claims: z.number(),
  by_mutation_type: z.record(z.string(), z.number()),
}).openapi({ description: 'Aggregate mutation statistics for a user.' });

export const AuditRecentResponseSchema = z.object({
  mutations: z.array(ClaimVersionRowSchema),
  count: z.number(),
}).openapi({ description: 'Newest-first mutation rows for a user.' });

const AuditTrailEntryResponseSchema = z.object({
  version_id: z.string(),
  claim_id: z.string(),
  content: z.string(),
  mutation_type: z.enum(['add', 'update', 'supersede', 'delete', 'clarify']).nullable(),
  mutation_reason: z.string().nullable(),
  actor_model: z.string().nullable(),
  contradiction_confidence: z.number().nullable(),
  previous_version_id: z.string().nullable(),
  superseded_by_version_id: z.string().nullable(),
  valid_from: IsoDateString,
  valid_to: IsoDateStringOrNull,
  memory_id: z.string().nullable(),
}).openapi({ description: 'Single entry in a memory\'s audit trail.' });

export const AuditTrailResponseSchema = z.object({
  memory_id: z.string(),
  trail: z.array(AuditTrailEntryResponseSchema),
  version_count: z.number(),
}).openapi({ description: 'Full version trail for a single memory.' });

export const TrustResponseSchema = z.object({
  agent_id: z.string(),
  trust_level: z.number(),
}).openapi({ description: '(userId, agentId) trust record.' });

export const ConflictsListResponseSchema = z.object({
  conflicts: z.array(MemoryConflictRowSchema),
  count: z.number(),
}).openapi({ description: 'Open agent-trust conflicts for a user.' });

export const ResolveConflictResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['resolved_new', 'resolved_existing', 'resolved_both']),
}).openapi({ description: 'Resolved-conflict echo.' });

export const AutoResolveConflictsResponseSchema = z.object({
  resolved: z.number(),
}).openapi({ description: 'Count of conflicts auto-resolved in the batch pass.' });

// Document-route response schemas live in `document-response-schemas`
// (re-exported at the top of this file).
