-- 20260512_temporal_state.sql
-- BEAM v38 — Temporal state layer (focused Mem0 temporal-reasoning subset).
--
-- Adds three columns to `memories` that describe an evolving fact:
--   state_key   stable identifier for an evolving fact ("user:1:location")
--   event_start when the fact became true
--   event_end   when the fact stopped being true (NULL = still active)
--
-- Backfilled NULL for legacy rows (column NULL semantics: row is not a
-- stateful claim). Gated at the write/read seams by
-- TEMPORAL_STATE_ENABLED=true; the column write/read carries zero overhead
-- when the flag is off because the columns stay NULL.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS state_key TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_start TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_end TIMESTAMPTZ DEFAULT NULL;

-- Partial index optimized for the dominant read path:
--   "current state for user U under state_key K" → WHERE event_end IS NULL
-- Includes user_id first for tenant isolation, state_key second for fast
-- key-equality lookups, and event_end as the partial predicate.
CREATE INDEX IF NOT EXISTS idx_memories_state_key_active
  ON memories (user_id, state_key)
  WHERE event_end IS NULL
    AND state_key IS NOT NULL
    AND deleted_at IS NULL;

-- Companion index for supersede UPDATE — finds all prior memories with
-- the same (user_id, state_key) so we can flip their event_end to the
-- new event_start. Kept unfiltered on event_end so the supersede sweep
-- catches both active and prior-superseded rows.
CREATE INDEX IF NOT EXISTS idx_memories_state_key_all
  ON memories (user_id, state_key)
  WHERE state_key IS NOT NULL
    AND deleted_at IS NULL;
