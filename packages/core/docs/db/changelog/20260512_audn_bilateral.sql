-- 20260512_audn_bilateral.sql
-- BEAM CR fix: AUDN bilateral preservation for contradictions.
--
-- When AUDN's DELETE/SUPERSEDE path would discard the prior side of a
-- contradiction, the bilateral path keeps both rows in memories and
-- records the conflict in memory_contradictions. Retrieval enriches
-- top-K hits whose counterpart memory is still active.

-- Add contradiction_active flag and bidirectional counterpart reference to memories
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS contradicts_memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contradiction_active BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_memories_contradiction_active
  ON memories (user_id, contradiction_active) WHERE contradiction_active = true;

-- Standalone contradictions table for analytics + Reflect emission.
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
