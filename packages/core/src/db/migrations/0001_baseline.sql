/**
 * atomicmemory-core Schema — active memory projection plus contradiction-safe
 * claim/version history. Idempotent: safe to re-run on every startup.
 *
 * IMPORTANT: This schema uses CREATE TABLE/INDEX IF NOT EXISTS so it can run
 * on every app startup without data loss. Adding new columns to existing tables
 * requires explicit ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements — a
 * plain column definition inside CREATE TABLE IF NOT EXISTS will be silently
 * ignored if the table already exists.
 */

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_episodes_user_site ON episodes (user_id, source_site);

CREATE TABLE IF NOT EXISTS canonical_memory_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  object_family TEXT NOT NULL
    CHECK (object_family IN ('ingested_fact')),
  payload_format TEXT NOT NULL DEFAULT 'json',
  canonical_payload JSONB NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lineage JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_memory_objects_user_created
  ON canonical_memory_objects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'semantic'
    CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'composite')),
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,  -- FK to episodes removed: non-transactional writes with pgvector can't guarantee ordering
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_clarification')),
  metadata JSONB DEFAULT '{}',
  keywords TEXT NOT NULL DEFAULT '',
  namespace TEXT DEFAULT NULL,
  summary TEXT NOT NULL DEFAULT '',        -- L0: abstract/headline (~100 tokens)
  overview TEXT NOT NULL DEFAULT '',       -- L1: condensed overview (~1000 tokens)
  trust_score REAL NOT NULL DEFAULT 1.0   -- Phase 3: source + content trust (0.0–1.0)
    CHECK (trust_score >= 0.0 AND trust_score <= 1.0),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when the conversation actually happened (vs created_at = DB insertion time)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  expired_at TIMESTAMPTZ DEFAULT NULL,   -- Phase 4: set when superseded (temporal invalidation)
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  -- Phase 7: 4-network memory separation (Hindsight-inspired)
  network TEXT NOT NULL DEFAULT 'experience'
    CHECK (network IN ('world', 'experience', 'opinion', 'observation')),
  opinion_confidence REAL DEFAULT NULL
    CHECK (opinion_confidence IS NULL OR (opinion_confidence >= 0.0 AND opinion_confidence <= 1.0)),
  observation_subject TEXT DEFAULT NULL,
  -- Phase 8: deferred AUDN reconciliation
  deferred_audn BOOLEAN NOT NULL DEFAULT false,
  audn_candidates JSONB DEFAULT NULL,  -- serialized candidates for background reconciliation
  -- Phase 9: workspace / multi-agent scoping
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL,
  visibility TEXT DEFAULT NULL
    CHECK (visibility IS NULL OR visibility IN ('agent_only', 'restricted', 'workspace'))
);

CREATE INDEX IF NOT EXISTS idx_memories_deferred_audn ON memories (user_id)
  WHERE deferred_audn = true AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_user_site ON memories (user_id, source_site)
  WHERE deleted_at IS NULL AND expired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_user_created ON memories (user_id, created_at)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Full-text search: indexes both paraphrased content AND extracted keywords.
-- Keywords preserve proper nouns, dates, and project names that paraphrasing loses.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', content) || to_tsvector('simple', keywords)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin (search_vector)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories (namespace)
  WHERE deleted_at IS NULL AND expired_at IS NULL AND namespace IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_network ON memories (user_id, network)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories (workspace_id, agent_id)
  WHERE deleted_at IS NULL AND expired_at IS NULL AND workspace_id IS NOT NULL;

-- Visibility grants for restricted memories (workspace scoping)
CREATE TABLE IF NOT EXISTS memory_visibility_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  grantee_agent_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (memory_id, grantee_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_visibility_grants_memory ON memory_visibility_grants (memory_id);
CREATE INDEX IF NOT EXISTS idx_visibility_grants_agent ON memory_visibility_grants (grantee_agent_id);

CREATE INDEX IF NOT EXISTS idx_memories_observation_subject ON memories (user_id, observation_subject)
  WHERE network = 'observation' AND deleted_at IS NULL AND expired_at IS NULL;

-- Workspace columns added via ALTER TABLE at the bottom of this file (Phase 5 Step 9).
CREATE TABLE IF NOT EXISTS memory_atomic_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  parent_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  fact_text TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  fact_type TEXT NOT NULL DEFAULT 'knowledge'
    CHECK (fact_type IN ('preference', 'project', 'knowledge', 'person', 'plan')),
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,
  keywords TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_parent ON memory_atomic_facts (parent_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_user ON memory_atomic_facts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_embedding ON memory_atomic_facts
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', fact_text) || to_tsvector('simple', keywords)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_fts ON memory_atomic_facts USING gin (search_vector);

-- Workspace columns added via ALTER TABLE at the bottom of this file (Phase 5 Step 9).
CREATE TABLE IF NOT EXISTS memory_foresight (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  parent_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  foresight_type TEXT NOT NULL DEFAULT 'plan'
    CHECK (foresight_type IN ('plan', 'goal', 'scheduled', 'expected_state')),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_foresight_parent ON memory_foresight (parent_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_foresight_user_valid ON memory_foresight (user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_memory_foresight_embedding ON memory_foresight
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Observation regeneration trigger (async, decoupled from ingest)
CREATE TABLE IF NOT EXISTS observation_dirty (
  user_id   TEXT NOT NULL,
  subject   TEXT NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, subject)
);

-- SCOPE_TODO: Claims are intentionally user-scoped — AUDN contradiction resolution
-- is cross-workspace. Workspace-scoped claims are a Phase 8+ concern.
CREATE TABLE IF NOT EXISTS memory_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  current_version_id UUID DEFAULT NULL,
  slot_key TEXT DEFAULT NULL,
  subject_entity_id UUID DEFAULT NULL,
  relation_type TEXT DEFAULT NULL
    CHECK (relation_type IS NULL OR relation_type IN (
      'uses', 'works_on', 'works_at', 'located_in', 'knows',
      'prefers', 'created', 'belongs_to', 'studies', 'manages'
    )),
  object_entity_id UUID DEFAULT NULL,
  valid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalid_at TIMESTAMPTZ DEFAULT NULL,
  invalidated_at TIMESTAMPTZ DEFAULT NULL,
  invalidated_by_version_id UUID DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (invalid_at IS NULL OR invalid_at >= valid_at)
);

CREATE INDEX IF NOT EXISTS idx_memory_claims_user ON memory_claims (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_claims_user_valid
  ON memory_claims (user_id, valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_memory_claims_user_slot
  ON memory_claims (user_id, slot_key)
  WHERE slot_key IS NOT NULL;

-- SCOPE_TODO: Claim versions inherit user-scoped claim ownership — same rationale as memory_claims.
CREATE TABLE IF NOT EXISTS memory_claim_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  memory_id UUID UNIQUE REFERENCES memories(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5
    CHECK (importance >= 0.0 AND importance <= 1.0),
  source_site TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  episode_id UUID /* REFERENCES episodes(id) ON DELETE SET NULL -- removed for non-transactional pgvector compat */,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  superseded_by_version_id UUID DEFAULT NULL,
  mutation_type TEXT DEFAULT NULL
    CHECK (mutation_type IS NULL OR mutation_type IN ('add', 'update', 'supersede', 'delete', 'clarify')),
  mutation_reason TEXT DEFAULT NULL,
  previous_version_id UUID DEFAULT NULL,
  actor_model TEXT DEFAULT NULL,
  contradiction_confidence REAL DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_claim ON memory_claim_versions (claim_id);
CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_user_valid
  ON memory_claim_versions (user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_claim_valid
  ON memory_claim_versions (claim_id, valid_from, valid_to);

CREATE INDEX IF NOT EXISTS idx_memory_claim_versions_embedding ON memory_claim_versions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_version_id UUID NOT NULL
    REFERENCES memory_claim_versions(id) ON DELETE CASCADE,
  episode_id UUID /* REFERENCES episodes(id) ON DELETE SET NULL -- removed for non-transactional pgvector compat */,
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  quote_text TEXT NOT NULL DEFAULT '',
  speaker TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_evidence_version ON memory_evidence (claim_version_id);

-- Memory links for 1-hop link expansion (Phase 2, A-MEM style)
-- Bidirectional: stored as (source_id, target_id) where source_id < target_id
-- to avoid duplicate pairs. Query both directions at read time.
CREATE TABLE IF NOT EXISTS memory_links (
  source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  similarity REAL NOT NULL CHECK (similarity >= 0.0 AND similarity <= 1.0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links (target_id);

-- Phase 5: Entity graph — structured entities extracted from memories
-- SCOPE_TODO: Entities are user-global (entity dedup crosses workspace boundaries).
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('person', 'tool', 'project', 'organization', 'place', 'concept')),
  embedding vector(768) NOT NULL,
  alias_names TEXT[] NOT NULL DEFAULT '{}',
  normalized_alias_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_user ON entities (user_id);
CREATE INDEX IF NOT EXISTS idx_entities_user_type ON entities (user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_user_normalized
  ON entities (user_id, entity_type, normalized_name);
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Junction table: many memories ↔ many entities
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities (entity_id);

-- Phase 4: Temporal Linkage List (TLL).
-- Per-entity sparse graph of event nodes with predecessor/successor edges.
-- Karpathy-minimal: append on ingest, traverse on EO/MSR/TR queries.
-- Targets the abilities Mem0 explicitly admits their architecture doesn't
-- crack at 10M (temporal reasoning, event ordering, multi-session reasoning).
-- The unique architectural primitive nobody has shipped publicly.
CREATE TABLE IF NOT EXISTS temporal_linkage_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  predecessor_memory_id UUID DEFAULT NULL REFERENCES memories(id) ON DELETE CASCADE,
  observation_date TIMESTAMPTZ NOT NULL,
  position_in_chain INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, entity_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_tll_entity_chain
  ON temporal_linkage_list (user_id, entity_id, position_in_chain);
CREATE INDEX IF NOT EXISTS idx_tll_memory
  ON temporal_linkage_list (memory_id);

-- Defense-in-depth: unique (chain, position) so any future code path that
-- bypasses the advisory-lock append fails at the DB layer instead of
-- silently producing duplicate positions. Idempotent for fresh and
-- existing schemas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tll_chain_position_unique
  ON temporal_linkage_list (user_id, entity_id, position_in_chain);

-- Align predecessor FK with memory FK (CASCADE) so a hard-deleted memory
-- removes the dependent chain node instead of leaving a half-broken
-- predecessor pointer that breaks backward chain traversal. Idempotent:
-- re-applying the constraint overwrites any prior ON DELETE SET NULL
-- definition. Required for existing databases since the table-level
-- CREATE TABLE IF NOT EXISTS above does not update column constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'temporal_linkage_list'
      AND constraint_name = 'temporal_linkage_list_predecessor_memory_id_fkey'
  ) THEN
    ALTER TABLE temporal_linkage_list
      DROP CONSTRAINT temporal_linkage_list_predecessor_memory_id_fkey;
  END IF;
  ALTER TABLE temporal_linkage_list
    ADD CONSTRAINT temporal_linkage_list_predecessor_memory_id_fkey
    FOREIGN KEY (predecessor_memory_id) REFERENCES memories(id)
    ON DELETE CASCADE;
END$$;

-- =====================================================================
-- First-mention events (chronological topic-introduction list)
-- =====================================================================
-- Per-user list of "the first time topic X was introduced in conversation."
-- Distinct from facts (which are atomic claims) and memories (which are
-- ingested chunks). The grain matches event-ordering rubrics:
-- "in what order did the user bring up these aspects."
--
-- Generated post-ingest by FirstMentionService via a single LLM call that
-- scans the full conversation and outputs a JSON array of first-mention
-- events. Idempotent on (user_id, memory_id) so re-running doesn't duplicate.
CREATE TABLE IF NOT EXISTS first_mention_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  turn_id INTEGER NOT NULL,
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  anchor_date TIMESTAMPTZ DEFAULT NULL,
  position_in_conversation INTEGER NOT NULL,
  source_site TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_first_mention_user_position
  ON first_mention_events (user_id, position_in_conversation);

CREATE INDEX IF NOT EXISTS idx_first_mention_user_topic
  ON first_mention_events USING GIN (to_tsvector('english', topic));

-- Entity relations: typed, directed edges between entities with temporal validity
CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL
    CHECK (relation_type IN (
      'uses', 'works_on', 'works_at', 'located_in', 'knows',
      'prefers', 'created', 'belongs_to', 'studies', 'manages'
    )),
  source_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  confidence REAL NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations (source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations (target_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_user ON entity_relations (user_id);

-- Phase 6: Lessons store — detected failure patterns for pre-action defense (A-MemGuard)
-- SCOPE_TODO: Lessons are user-global (failure patterns are personal, not per-workspace).
CREATE TABLE IF NOT EXISTS lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  lesson_type TEXT NOT NULL
    CHECK (lesson_type IN (
      'injection_blocked', 'false_memory', 'contradiction_pattern',
      'user_reported', 'consensus_violation', 'trust_violation'
    )),
  pattern TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  source_memory_ids UUID[] NOT NULL DEFAULT '{}',
  source_query TEXT DEFAULT NULL,
  severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lessons_user_active ON lessons (user_id) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_lessons_type ON lessons (user_id, lesson_type);
CREATE INDEX IF NOT EXISTS idx_lessons_embedding ON lessons
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Temporal metadata index (observed_at separates conversation time from DB insertion time)
CREATE INDEX IF NOT EXISTS idx_memories_user_observed ON memories (user_id, observed_at)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

-- Agent trust levels for multi-agent conflict resolution (from hive-mind Phase 4)
CREATE TABLE IF NOT EXISTS agent_trust (
  agent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trust_level REAL NOT NULL DEFAULT 0.5
    CHECK (trust_level >= 0.0 AND trust_level <= 1.0),
  display_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_trust_user ON agent_trust (user_id);

-- Conflict tracking for CLARIFY escalation and auto-resolution
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  new_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  existing_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  new_agent_id TEXT DEFAULT NULL,
  existing_agent_id TEXT DEFAULT NULL,
  new_trust_level REAL DEFAULT NULL,
  existing_trust_level REAL DEFAULT NULL,
  contradiction_confidence REAL NOT NULL DEFAULT 0.5,
  clarification_note TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'auto_resolved', 'resolved_new', 'resolved_existing', 'resolved_both')),
  resolution_policy TEXT DEFAULT NULL,
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_resolve_after TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_conflicts_user_status ON memory_conflicts (user_id, status)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_conflicts_auto_resolve ON memory_conflicts (auto_resolve_after)
  WHERE status = 'open' AND auto_resolve_after IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Phase 5 Step 9: Add workspace scope columns to representation tables.
-- These are idempotent ALTER TABLE statements that run safely on every startup.
-- NULL means the row was created by user-scoped ingest (pre-Phase 5).
-- ---------------------------------------------------------------------------

ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS workspace_id UUID DEFAULT NULL;
ALTER TABLE memory_atomic_facts ADD COLUMN IF NOT EXISTS agent_id UUID DEFAULT NULL;

ALTER TABLE memory_foresight ADD COLUMN IF NOT EXISTS workspace_id UUID DEFAULT NULL;
ALTER TABLE memory_foresight ADD COLUMN IF NOT EXISTS agent_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_atomic_facts_workspace
  ON memory_atomic_facts (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_foresight_workspace
  ON memory_foresight (workspace_id) WHERE workspace_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- TBC Phase 3 (2026-05-06): Typed Belief Calculus first-class storage.
-- Promotes belief state from `memories.metadata` JSONB into typed columns +
-- a new `belief_edges` table. All additions are idempotent (IF NOT EXISTS).
-- Pre-migration databases stay queryable; tbc-execution.ts dual-writes
-- during the migration window.
-- Activated only when TBC_ENABLED=true; defaults preserve existing behavior.
-- ---------------------------------------------------------------------------

-- Belief confidence in [0,1]; default 1.0 = "fully believed" (matches AUDN's
-- no-confidence-tracking baseline).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0
  CHECK (confidence >= 0.0 AND confidence <= 1.0);

-- Belief tier — controls how the claim influences answer generation.
--   standard:   default tier; normal weight in retrieval
--   directive:  promoted; injected as a "must follow" rule in answer prompt
--   demoted:    challenged; lower weight + flagged for re-evaluation
--   retracted:  believed false; excluded from default retrieval
ALTER TABLE memories ADD COLUMN IF NOT EXISTS belief_tier TEXT DEFAULT 'standard'
  CHECK (belief_tier IN ('standard', 'directive', 'demoted', 'retracted'));

-- The TBC operator that most recently mutated this memory.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS mutation_type TEXT DEFAULT NULL
  CHECK (mutation_type IS NULL OR mutation_type IN (
    'AFFIRM', 'UPDATE', 'RETRACT', 'SUPERSEDE',
    'PROMOTE', 'DEMOTE', 'EVIDENCE_FOR', 'COUNTER'
  ));

-- Tier-aware retrieval index (directives surface fast, retracted excluded).
CREATE INDEX IF NOT EXISTS idx_memories_belief_tier
  ON memories (user_id, belief_tier)
  WHERE deleted_at IS NULL AND expired_at IS NULL AND belief_tier != 'standard';

-- Confidence-weighted retrieval index (low-confidence demotion).
CREATE INDEX IF NOT EXISTS idx_memories_confidence
  ON memories (user_id, confidence DESC)
  WHERE deleted_at IS NULL AND expired_at IS NULL;

-- belief_edges: typed belief graph between claims.
--   evidence_for:  source supports target's confidence (positive weight)
--   counter:       source contradicts target's confidence (negative weight)
--   supersedes:    source replaces target (more specific or general)
--   promotes:      source promoted target to directive tier
--   demotes:       source challenged target without retracting
CREATE TABLE IF NOT EXISTS belief_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_id UUID NOT NULL,
  edge_type TEXT NOT NULL CHECK (edge_type IN (
    'evidence_for', 'counter', 'supersedes', 'promotes', 'demotes'
  )),
  weight REAL NOT NULL DEFAULT 0.0
    CHECK (weight >= -1.0 AND weight <= 1.0),
  rationale TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL
);

-- For "all evidence pointing at this claim" queries (queryable belief state).
CREATE INDEX IF NOT EXISTS idx_belief_edges_target
  ON belief_edges (target_id, edge_type, created_at DESC);

-- For "all claims this evidence supports/counters" queries.
CREATE INDEX IF NOT EXISTS idx_belief_edges_source
  ON belief_edges (source_id, edge_type);

-- User-scoped traversal (multi-tenant safety).
CREATE INDEX IF NOT EXISTS idx_belief_edges_user_target
  ON belief_edges (user_id, target_id);

-- ---------------------------------------------------------------------------
-- Hierarchical Retrieval (2026-05-07): three-level memory hierarchy for
-- BEAM-10M scale (10 conversations × ~1.4M tokens each = ~14M total context).
-- session_summaries + conv_summaries indexed via HNSW on summary_embedding.
-- Activated only when HIERARCHICAL_RETRIEVAL_ENABLED=true; defaults preserve
-- existing flat-retrieval behavior.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_index INTEGER NOT NULL,
  summary_text TEXT NOT NULL,
  summary_embedding vector(768) NOT NULL,
  topics TEXT[] NOT NULL DEFAULT '{}',
  fact_count INTEGER NOT NULL DEFAULT 0,
  occurred_start TIMESTAMPTZ DEFAULT NULL,
  occurred_end TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS conv_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  summary_embedding vector(768) NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  fact_count INTEGER NOT NULL DEFAULT 0,
  occurred_start TIMESTAMPTZ DEFAULT NULL,
  occurred_end TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id UUID DEFAULT NULL,
  agent_id UUID DEFAULT NULL
);

-- Stage-1 retrieval: top-K conversations by summary similarity.
CREATE INDEX IF NOT EXISTS idx_conv_summaries_embedding
  ON conv_summaries USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Stage-2 retrieval: top-K sessions within selected conversations.
CREATE INDEX IF NOT EXISTS idx_session_summaries_embedding
  ON session_summaries USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- User-scoped lookups for both summary tables.
CREATE INDEX IF NOT EXISTS idx_session_summaries_user_conv
  ON session_summaries (user_id, conversation_id, session_index);

CREATE INDEX IF NOT EXISTS idx_conv_summaries_user
  ON conv_summaries (user_id, conversation_id);

-- ---------------------------------------------------------------------------
-- Sprint 3 (2026-05-10): Topic-abstraction layer for the EO experiment.
-- Per-memory conceptual topic (3-7 word LLM summary at higher abstraction
-- than raw facts) + its embedding. Surfaced via a dedicated RRF channel at
-- retrieval. Activated only when TOPIC_ABSTRACTION_ENABLED=true; defaults
-- preserve existing behavior on un-migrated rows. Design doc:
-- benchmarks-sprint3/2026-05-10-am-baseline-and-rerank-design.md.
-- ---------------------------------------------------------------------------
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic_abstraction TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic_embedding vector(768) DEFAULT NULL;
-- Pointer to the recap this memory has been consolidated into (NULL until
-- the Recap-layer builder runs). Used to filter out already-consolidated
-- memories from future recap-cluster candidates.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS recap_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_topic_embedding
  ON memories USING hnsw (topic_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200)
  WHERE topic_embedding IS NOT NULL AND deleted_at IS NULL AND expired_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sprint 3 (2026-05-10): Recap layer for cross-session synthesis.
-- A Recap is an LLM-synthesized narrative aggregating N memories that share
-- a conceptual topic. Surfaced via its own RRF channel at retrieval. Cog-sci
-- analogue: hippocampal consolidation. Three of the four next-gen memory
-- systems converge on this primitive (Hindsight observations, Honcho
-- dreaming, X-Mem Episodes, EverMemOS multi-pass restructuring). Activated
-- only when RECAP_LAYER_ENABLED=true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  recap_text TEXT NOT NULL,
  recap_embedding vector(768) NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  member_memory_ids UUID[] NOT NULL DEFAULT '{}',
  member_count INTEGER NOT NULL DEFAULT 0,
  time_range_start TIMESTAMPTZ DEFAULT NULL,
  time_range_end TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workspace_id UUID DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_recaps_user_topic
  ON recaps (user_id, topic) WHERE workspace_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_recaps_embedding
  ON recaps USING hnsw (recap_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- ---------------------------------------------------------------------------
-- Sprint 3 v1.5 (2026-05-11): user-profile channel (H2 from haiku-080).
-- One row per user holds the synthesized profile that is pinned to every
-- answer prompt. Updated by user-profile-builder.ts after each ingest
-- that stores >= 3 new facts. See also:
--   docs/db/changelog/20260511_user_profiles.sql (provenance copy)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id           TEXT PRIMARY KEY,
  profile_text      TEXT NOT NULL,
  source_memory_ids TEXT[] NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_profiles_updated_at_idx
  ON user_profiles (updated_at DESC);

-- ---------------------------------------------------------------------------
-- Sprint 4 (2026-05-11): Entity-Attribute Index (EAI).
-- Stores (entity, attribute, value) triples extracted at ingest time, indexed
-- for fast lookup by entity name and/or attribute key on queries like
-- "how many X did I do?" or "what is my Y?". Distinct from the entity graph
-- (entities, entity_relations) which captures structural relations.
-- See also: docs/db/changelog/20260511_entity_attributes.sql.
-- Activated only when ENTITY_ATTRIBUTES_ENABLED=true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_attributes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  entity_name     TEXT NOT NULL,
  attribute_key   TEXT NOT NULL,
  attribute_value TEXT NOT NULL,
  value_type      TEXT NOT NULL CHECK (value_type IN ('number','string','list','boolean','date')),
  source_memory_id UUID,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_attributes_user_entity
  ON entity_attributes (user_id, lower(entity_name));
CREATE INDEX IF NOT EXISTS idx_entity_attributes_user_attribute
  ON entity_attributes (user_id, lower(attribute_key));
CREATE INDEX IF NOT EXISTS idx_entity_attributes_observed
  ON entity_attributes (user_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- BEAM-0.85 Phase 2 (2026-05-12): Literal value extraction for IE/KU.
-- Captures exact (entity, attribute, value) triples from ingested facts so
-- specialist lookup can answer literal factual questions via SQL.
-- See also: docs/db/changelog/20260512_entity_values.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('date', 'number', 'string', 'duration', 'list')),
  observed_at TIMESTAMPTZ NOT NULL,
  fact_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_entity_values_lookup
  ON entity_values (user_id, lower(entity), lower(attribute), observed_at DESC);

CREATE INDEX IF NOT EXISTS ix_entity_values_fact
  ON entity_values (fact_id);

-- ---------------------------------------------------------------------------
-- BEAM-0.85 (2026-05-12): Async Reflect step storage.
-- Stores synthesized observations per (user_id, conversation_id), plus the
-- Postgres-backed queue used by the reflect worker.
-- See also: docs/db/changelog/20260512_session_reflections.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  observation TEXT NOT NULL,
  observation_type TEXT NOT NULL CHECK (observation_type IN (
    'entity_state', 'event_summary', 'preference',
    'contradiction', 'decision', 'numeric_value'
  )),
  evidence_memory_ids TEXT[] NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_session_reflections_user_conv
  ON session_reflections (user_id, conversation_id);

CREATE INDEX IF NOT EXISTS ix_session_reflections_embedding
  ON session_reflections USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS reflection_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tried_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_reflection_jobs_pending_unique
  ON reflection_jobs (user_id, conversation_id)
  WHERE status IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS ix_reflection_jobs_status_created
  ON reflection_jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- BEAM-0.85 (2026-05-12): Always-on per-entity ENTITY_CARD channel.
-- Mirrors Honcho's "peer card" pattern. The Reflect worker (Sonnet 4.5)
-- maintains one card per (user_id, conversation_id, entity_name); the
-- search pipeline injects all cards for the active conversation at the top
-- of every answer-LLM prompt under the `## ENTITY_STATE` heading.
-- See also: docs/db/changelog/20260512_entity_cards.sql.
-- Activated only when ENTITY_CARD_ENABLED=true.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  card_text TEXT NOT NULL,
  source_observation_ids TEXT[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_entity_cards_unique
  ON entity_cards (user_id, conversation_id, entity_name);
CREATE INDEX IF NOT EXISTS ix_entity_cards_user_conv
  ON entity_cards (user_id, conversation_id);

-- ---------------------------------------------------------------------------
-- BEAM CR fix (2026-05-12): AUDN bilateral preservation for contradictions.
-- When the flag-gated bilateral path fires instead of DELETE/SUPERSEDE,
-- both prior + new memory remain in `memories` with `contradiction_active=true`
-- and `contradicts_memory_id` pointing at the counterpart. A row in
-- `memory_contradictions` records the conflict with both summaries verbatim
-- so retrieval can quote BOTH sides for CR-style questions.
-- See also: docs/db/changelog/20260512_audn_bilateral.sql.
-- Activated only when CONTRADICTION_PRESERVATION_ENABLED=true.
-- ---------------------------------------------------------------------------
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS contradicts_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contradiction_active BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_memories_contradiction_active
  ON memories (user_id, contradiction_active) WHERE contradiction_active = true;

CREATE TABLE IF NOT EXISTS memory_contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  left_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  right_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  left_summary TEXT NOT NULL,
  right_summary TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  resolution_note TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_memory_contradictions_user
  ON memory_contradictions (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS ix_memory_contradictions_left
  ON memory_contradictions (left_memory_id);
CREATE INDEX IF NOT EXISTS ix_memory_contradictions_right
  ON memory_contradictions (right_memory_id);

-- ---------------------------------------------------------------------------
-- BEAM v38 (2026-05-12): Temporal state layer — focused Mem0
-- temporal-reasoning subset for KU lift.
--
-- Adds three columns on `memories` describing an evolving fact:
--   state_key   stable identifier for an evolving fact ("user:1:location")
--   event_start when the fact became true
--   event_end   when the fact stopped being true (NULL = still active)
--
-- See also: docs/db/changelog/20260512_temporal_state.sql.
-- Activated only when TEMPORAL_STATE_ENABLED=true.
-- ---------------------------------------------------------------------------
ALTER TABLE memories ADD COLUMN IF NOT EXISTS state_key TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_start TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_end TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_state_key_active
  ON memories (user_id, state_key)
  WHERE event_end IS NULL
    AND state_key IS NOT NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_state_key_all
  ON memories (user_id, state_key)
  WHERE state_key IS NOT NULL
    AND deleted_at IS NULL;
-- Document pipeline (Phase 1 of the large-file ingestion plan).
--
-- See `the large-file ingestion design notes`.
--
-- Phase 1 ships the pointer-only document registry: `raw_sources` is a
-- per-(user, source_site, provider, account) namespace; `raw_documents`
-- represents one registered upstream object. The CHECK constraints on
-- `storage_mode` / `registration_status` / `raw_storage_status` accept the
-- full enum that later phases will populate (managed_blob, inline_text_stored,
-- blob_stored) so Phase 3 doesn't need a CHECK migration. The service layer
-- enforces `storage_mode = 'pointer_only'` until Phase 3 lands.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS raw_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  source_site TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT,
  storage_mode TEXT NOT NULL DEFAULT 'pointer_only'
    CHECK (storage_mode IN ('pointer_only', 'managed_blob', 'inline_small_text')),
  retention_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- COALESCE(account_id, '') keeps NULL account_ids in a single namespace slot
-- (Postgres treats NULLs as distinct in plain unique indexes, which would let
-- two rows with the same user/source/provider but different consent contexts
-- collide).
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_sources_namespace
  ON raw_sources (user_id, source_site, provider, COALESCE(account_id, ''));
CREATE INDEX IF NOT EXISTS idx_raw_sources_user
  ON raw_sources (user_id);

CREATE TABLE IF NOT EXISTS raw_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  raw_source_id UUID NOT NULL REFERENCES raw_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  external_uri TEXT,
  display_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  content_hash TEXT,
  provider_version TEXT,
  source_modified_at TIMESTAMPTZ,
  storage_mode TEXT NOT NULL DEFAULT 'pointer_only'
    CHECK (storage_mode IN ('pointer_only', 'managed_blob', 'inline_small_text')),
  -- storage_uri / storage_provider stay NULL in Phase 1 (no managed blob).
  storage_uri TEXT,
  storage_provider TEXT,
  registration_status TEXT NOT NULL DEFAULT 'registered'
    CHECK (registration_status IN ('registered', 'registration_failed')),
  raw_storage_status TEXT NOT NULL DEFAULT 'pointer_recorded'
    CHECK (raw_storage_status IN
      ('pointer_recorded', 'blob_stored', 'inline_text_stored', 'raw_storage_failed', 'blob_deleted')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Phase 3 broadened the `raw_storage_status` CHECK to include
-- `blob_deleted` (terminal post-cleanup state for tombstoned managed-blob
-- rows). The Filecoin raw-content-store lifecycle refactor (Slice 2)
-- further broadens it to include the eventual-provider states:
--   * `blob_pending` — provider accepted the upload but storage /
--     retrievability is not yet confirmed (e.g. a Filecoin onramp
--     that returns before the deal is sealed). Slice 3 writes this
--     when `put()` returns `status: 'pending'`.
--   * `blob_available` — schema-reserved for the Phase 3 reconciliation
--     worker that promotes `blob_pending` rows once `head()` confirms
--     retrievability. No Phase-1 writer.
--   * `blob_archival_failed` — schema-reserved for the Phase 3
--     reconciler's permanent-failure path. No Phase-1 writer.
--   * `blob_tombstoned` — schema-reserved for Phase 2 Filecoin
--     deletes when the provider supports unpin-only semantics. No
--     Phase-1 writer.
--   * `blob_uploading` (Phase 5) — transient state during the upload
--     pipeline's α/β/β2/γ split. Phase α writes this with a claim_id
--     after seizing the slot; Phase γ flips it to the final terminal
--     state after the adapter returns. A row that stays in
--     `blob_uploading` past a process restart is recoverable via
--     same-bytes idempotent retry of `uploadRaw` — the reconciler
--     does NOT process `blob_uploading` rows.
-- Idempotent ALTER so the new values are accepted on existing test
-- DBs whose CREATE TABLE IF NOT EXISTS already locked in the prior CHECK.
ALTER TABLE raw_documents
  DROP CONSTRAINT IF EXISTS raw_documents_raw_storage_status_check;
ALTER TABLE raw_documents
  ADD CONSTRAINT raw_documents_raw_storage_status_check
  CHECK (raw_storage_status IN
    ('pointer_recorded', 'blob_stored', 'inline_text_stored', 'raw_storage_failed', 'blob_deleted',
     'blob_pending', 'blob_available', 'blob_archival_failed', 'blob_tombstoned',
     'blob_uploading'));

-- Filecoin lifecycle refactor (Phase 5) — typed claim + scheduling
-- columns moved out of JSONB. The upload pipeline's α/β/β2/γ split
-- writes a per-row claim_id when seizing the slot; the Phase 6
-- reconciler claims `blob_pending` rows on the same columns and
-- advances `next_check_at` via exponential backoff. `pending_since`
-- is the durable "row entered blob_pending at" timestamp the
-- observability layer reads for the `pending_age_seconds` metric.
ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS raw_storage_claim_id TEXT,
  ADD COLUMN IF NOT EXISTS raw_storage_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_storage_last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_storage_next_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_storage_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_storage_pending_since TIMESTAMPTZ;

-- Provider-side metadata for the managed blob (CID, piece CID, deal
-- id, onramp request id, gateway URL, etc.). Opaque to the upload
-- pipeline; the adapter's `put()` returns the shape and the row
-- formatter forwards it verbatim. Default `'{}'` so existing rows
-- and the pointer-only path stay schema-clean.
ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS raw_storage_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Phase 2 indexing fingerprint. Distinct from `content_hash` (which is
-- the upstream/provider-supplied raw-content hash) so that indexing
-- never overwrites caller-provided metadata. NULL means "not yet
-- indexed under the current chunker_version"; the indexer's idempotency
-- check compares the input text's hash against this column.
ALTER TABLE raw_documents ADD COLUMN IF NOT EXISTS indexed_content_hash TEXT;
ALTER TABLE raw_documents ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;

-- Phase B (document-ingest hardening) — per-layer status + last_error.
--
-- The audit at `the document ingest audit notes`
-- and the rev-18 hardening plan call for durable, observable
-- per-layer status so the UI/API stops pretending indexing is
-- instant and partial failures stop creating silent orphans.
--
--   * extraction_status — text-extraction layer: 'not_required'
--     (e.g. URL pointer with no body), 'pending' (registered, awaiting
--     extraction), 'running' (in-flight), 'complete', 'unsupported'
--     (`.parquet`, etc.), 'failed'.
--   * semantic_index_status — chunk + embed + index pipeline:
--     'not_required', 'pending', 'running', 'complete', 'failed',
--     'stale' (re-index needed; reserved).
--   * last_error — JSONB envelope `{ layer, code, message, occurred_at }`
--     scoped to the most-recent failure for any layer; cleared on the
--     next successful transition for that layer.
--
-- Cross-walk to spec naming (`the ingestion variation naming notes`):
-- `raw_storage_status` retains its prior values
-- (`pointer_recorded` / `blob_stored` / `inline_text_stored` /
-- `raw_storage_failed` / `blob_deleted`); rename can land later if
-- the migration is worth the churn.
ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS extraction_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS semantic_index_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE raw_documents ADD COLUMN IF NOT EXISTS last_error JSONB;

ALTER TABLE raw_documents
  DROP CONSTRAINT IF EXISTS raw_documents_extraction_status_check;
ALTER TABLE raw_documents
  ADD CONSTRAINT raw_documents_extraction_status_check
  CHECK (extraction_status IN
    ('not_required', 'pending', 'running', 'complete', 'unsupported', 'failed'));

ALTER TABLE raw_documents
  DROP CONSTRAINT IF EXISTS raw_documents_semantic_index_status_check;
ALTER TABLE raw_documents
  ADD CONSTRAINT raw_documents_semantic_index_status_check
  CHECK (semantic_index_status IN
    ('not_required', 'pending', 'running', 'complete', 'failed', 'stale'));

-- Recovery-relevant rows: documents with at least one layer in a
-- failure state. Partial index keeps it small on healthy deployments.
CREATE INDEX IF NOT EXISTS idx_raw_documents_status_failed
  ON raw_documents (user_id)
  WHERE deleted_at IS NULL
    AND (
      extraction_status = 'failed'
      OR semantic_index_status = 'failed'
      OR raw_storage_status = 'raw_storage_failed'
    );

-- Active-row idempotency: at most one live registration per
-- (user, source, external_id, version). Soft-deleted rows are excluded so
-- a re-registration after deletion creates a fresh row instead of colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_documents_active_unique
  ON raw_documents (user_id, raw_source_id, external_id, COALESCE(provider_version, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_raw_documents_user
  ON raw_documents (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_raw_documents_source
  ON raw_documents (raw_source_id) WHERE deleted_at IS NULL;

-- Memory provenance to documents/chunks. document_chunk_id is unused in
-- Phase 1 (chunks ship in Phase 2) but the column lands now so memories
-- created during the Phase 1 → 2 transition don't need a backfill migration.
-- No FK constraint yet — added once raw_documents/document_chunks deletion
-- semantics are reviewed alongside the chunk table in Phase 2.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS raw_document_id UUID DEFAULT NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS document_chunk_id UUID DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_raw_document
  ON memories (user_id, raw_document_id)
  WHERE raw_document_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_document_chunk
  ON memories (user_id, document_chunk_id)
  WHERE document_chunk_id IS NOT NULL AND deleted_at IS NULL;

-- Phase D — passport-feed grouped query support (rev 18).
-- The `GROUP BY raw_document_id` + `ARRAY_AGG(... ORDER BY created_at
-- DESC, id DESC)[1]` pattern in `passport-feed-repository.ts` lifts
-- (created_at DESC, id DESC) inside each (user_id, raw_document_id)
-- partition. A composite partial index on those four columns lets
-- Postgres skip the secondary sort entirely on the grouped branch
-- under real volume; the partial WHERE clause keeps the index lean
-- (memory rows that aren't document-backed or are tombstoned never
-- enter the hot path).
CREATE INDEX IF NOT EXISTS idx_memories_passport_grouped
  ON memories (user_id, raw_document_id, created_at DESC, id DESC)
  WHERE raw_document_id IS NOT NULL AND deleted_at IS NULL;

-- Phase D — passport-feed standalone branch support (rev 18).
-- The standalone-memory branch of the UNION ALL pages by
-- `(created_at DESC, id DESC)` filtered to memories with
-- `raw_document_id IS NULL`. The pre-existing
-- `idx_memories_user_created` is the wrong shape (no IS NULL
-- partial, no `id` tie-breaker). This partial index matches the
-- exact predicate the cursor walks.
CREATE INDEX IF NOT EXISTS idx_memories_passport_standalone
  ON memories (user_id, created_at DESC, id DESC)
  WHERE raw_document_id IS NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Document chunks (Phase 2 of the large-file ingestion plan).
--
-- One row per deterministic chunk derived from a registered document.
-- Chunks store their own embedding (so the chunk-level vector store
-- supports raw chunk lookup / debug / re-index without touching memories)
-- AND each chunk creates a sibling row in `memories` with
-- raw_document_id + document_chunk_id provenance — that's the surface
-- the existing /v1/memories/search retrieval pipeline finds.
--
-- (parser_version, chunker_version) pair lets a future code change
-- re-chunk a document without colliding with the prior generation —
-- the partial unique index keys on chunker_version, so a bumped
-- chunker_version causes fresh inserts to coexist with the old soft-
-- deleted rows. Phase 2 only ships chunker_version='phase2-fixed-v1'
-- and parser_version='phase2-text-v1'; future phases bump.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  raw_document_id UUID NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_start INTEGER NOT NULL CHECK (char_start >= 0),
  char_end INTEGER NOT NULL CHECK (char_end >= char_start),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  embedding vector(768) NOT NULL,
  parser_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Active-row uniqueness on (raw_document_id, chunk_index, chunker_version).
-- Soft-deleted rows are excluded so a re-index after a previous chunker
-- run leaves audit history intact while letting the new run succeed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_chunks_active_unique
  ON document_chunks (raw_document_id, chunk_index, chunker_version)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_document_chunks_document
  ON document_chunks (raw_document_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_chunks_user
  ON document_chunks (user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- ---------------------------------------------------------------------------
-- Storage artifacts (Step 4 of the storage-sibling plan).
--
-- One row per artifact tracked by the direct storage API, independent
-- of `raw_documents`. Pointer-mode rows carry a registered URI and
-- never persist bytes (the server NEVER fetches the URI itself);
-- managed-mode rows carry the adapter-returned URI plus the usual
-- pending → available / deleting → deleted/delete_failed lifecycle.
--
-- Owner scoping lives on `user_id`. `org_id` / `project_id` are
-- reserved for future multi-tenancy and stay NULL in v1.
--
-- Internal-only columns:
--   * `plaintext_hash` — SHA-256 of caller bytes; never on the wire
--     by default. The Step-5 response formatter exposes it only when
--     the row's `disclose_content_hash = true` AND the caller opted in
--     at put time.
--   * `stored_hash` — SHA-256 of the bytes the adapter actually wrote;
--     never on the wire under any condition.
--   * `last_error` — internal failure envelope for delete retries.
-- Step 5 is responsible for projecting the wire shape; this PR is
-- DB-only and is allowed to keep the internal columns visible in the
-- repository's row type.
--
-- FK direction: `raw_documents.storage_artifact_id REFERENCES
-- storage_artifacts(id)`. Step 7 wires the document-ingestion paths
-- to populate this column; Step 4 just defines the persistence
-- surface and the reverse-lookup index.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS storage_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  org_id TEXT,
  project_id TEXT,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('pointer', 'managed')),
  -- Nullable while the row is in `pending` (managed put before
  -- backend.put has returned a URI); set to the adapter URI on
  -- success, stays NULL on `failed`. `pointer` rows always supply
  -- the URI at insert time. The partial unique index below covers
  -- the post-set side of the contract.
  uri TEXT,
  status TEXT NOT NULL
    CHECK (status IN
      ('stored', 'pending', 'available', 'unavailable',
       'deleting', 'deleted', 'delete_failed', 'failed')),
  size_bytes BIGINT,
  content_type TEXT,
  -- Internal; never on the wire by default.
  plaintext_hash TEXT,
  -- Internal; never on the wire ever.
  stored_hash TEXT,
  content_encoding TEXT NOT NULL DEFAULT 'identity'
    CHECK (content_encoding IN ('identity', 'aes_gcm')),
  disclose_content_hash BOOLEAN NOT NULL DEFAULT FALSE,
  identifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
  lifecycle JSONB NOT NULL DEFAULT '{}'::jsonb,
  replication JSONB,
  verification JSONB,
  retrieval JSONB,
  provider_details JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error JSONB,
  -- CAS token for the upload pipeline (pending-row-first put). Held
  -- by `claimPendingArtifact`, cleared by `recordUploadedArtifact` /
  -- `markPutFailed`. Distinct from `delete_attempt_id` so the two
  -- lifecycle phases never collide.
  put_attempt_id UUID,
  delete_attempt_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Forward-compat migration for deployments that already created
-- `storage_artifacts` with `uri NOT NULL`. Idempotent: only fires
-- the ALTER when information_schema reports the column as still
-- NOT NULL, so a re-run against a freshly upgraded DB is a no-op
-- without relying on `EXCEPTION WHEN OTHERS` (workspace rule
-- forbids silent error swallowing).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'storage_artifacts'
       AND column_name = 'uri'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE storage_artifacts ALTER COLUMN uri DROP NOT NULL;
  END IF;
END $$;
ALTER TABLE storage_artifacts
  ADD COLUMN IF NOT EXISTS put_attempt_id UUID;

-- Concurrent `putManaged` callers must not produce two rows whose
-- adapter URI collides. The unique index is partial: only managed
-- rows with a URI set and not soft-deleted participate. Pointer
-- rows are exempt — a single user legitimately has multiple
-- pointer rows for the same caller-supplied URI (e.g. one created
-- by `putPointer` against the active backend, another auto-paired
-- to a document registration via `EXTERNAL_POINTER_PROVIDER`).
-- `pending` / `failed` rows carry `uri IS NULL` and also fall out
-- of the constraint naturally.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_storage_artifacts_user_managed_uri
  ON storage_artifacts (user_id, uri)
  WHERE uri IS NOT NULL AND deleted_at IS NULL AND mode = 'managed';

-- One-time cleanup: drop the over-broad index from an earlier rev
-- of this migration. Idempotent.
DROP INDEX IF EXISTS uniq_storage_artifacts_user_uri;

CREATE INDEX IF NOT EXISTS idx_storage_artifacts_user_status
  ON storage_artifacts (user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_storage_artifacts_user_provider
  ON storage_artifacts (user_id, provider) WHERE deleted_at IS NULL;
-- Cursor pagination keyed on (created_at DESC, id DESC) within a
-- user. Partial index keeps it lean for healthy deployments.
CREATE INDEX IF NOT EXISTS idx_storage_artifacts_user_created
  ON storage_artifacts (user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Non-partial unique index on (id, user_id). `id` alone is already the
-- primary key; the composite uniqueness exists so the owner-scoped
-- composite foreign key on raw_documents below has a valid target.
-- Postgres accepts a non-partial unique index as an FK target, and
-- this is the only place we need the (id, user_id) pair indexed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_artifacts_id_user
  ON storage_artifacts (id, user_id);

-- Reverse pointer from documents to their backing artifact. The FK is
-- COMPOSITE on (storage_artifact_id, user_id) so the schema itself
-- makes a USER_B raw_document pointing at USER_A's artifact
-- impossible — the row would have to match BOTH columns of the
-- referenced storage_artifacts row, and the artifact's `user_id`
-- column carries the canonical owner. Populated in Step 7.
--
-- NULL `storage_artifact_id` is legitimate for rows registered
-- without an `external_uri` (pointer-only registration stub) or rows
-- that pre-date Step 7.
ALTER TABLE raw_documents
  ADD COLUMN IF NOT EXISTS storage_artifact_id UUID NULL;
-- This baseline can be applied to fresh databases and may be replayed in
-- development by migration tooling. The composite FK is therefore added only
-- when it doesn't already exist, so repeated local runs don't take ACCESS
-- EXCLUSIVE on raw_documents to revalidate the same constraint.
-- The legacy single-column FK is dropped the same way for one-time
-- cleanup against any dev/test DB that applied the earlier shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'raw_documents_storage_artifact_id_fkey'
      AND conrelid = 'raw_documents'::regclass
  ) THEN
    ALTER TABLE raw_documents
      DROP CONSTRAINT raw_documents_storage_artifact_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'raw_documents_storage_artifact_owner_fkey'
      AND conrelid = 'raw_documents'::regclass
  ) THEN
    ALTER TABLE raw_documents
      ADD CONSTRAINT raw_documents_storage_artifact_owner_fkey
        FOREIGN KEY (storage_artifact_id, user_id)
        REFERENCES storage_artifacts (id, user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_raw_documents_storage_artifact
  ON raw_documents (storage_artifact_id) WHERE storage_artifact_id IS NOT NULL;

-- Phase 1 migration metadata. One row per successful migrate() call.
-- The most recent row by `applied_at` is the current effective version.
-- History is preserved so rolling deploys produce a visible audit trail.
CREATE TABLE IF NOT EXISTS schema_version (
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sdk_version     TEXT        NOT NULL,
  schema_sha256   TEXT        NOT NULL,
  notes           TEXT,
  PRIMARY KEY (applied_at)
);

CREATE INDEX IF NOT EXISTS idx_schema_version_applied_at
  ON schema_version (applied_at DESC);
