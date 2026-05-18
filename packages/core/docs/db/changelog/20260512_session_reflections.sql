-- 20260512_session_reflections.sql
-- Phase 1 of BEAM-0.85 plan: async Reflect step storage.
--
-- Two tables:
--   session_reflections: synthesized observations per (user_id, conversation_id),
--                        each citing evidence_memory_ids and embedded for retrieval
--   reflection_jobs:     Postgres-backed async work queue for the reflect worker

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
  embedding vector({{EMBEDDING_DIMENSIONS}}),
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
