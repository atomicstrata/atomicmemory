-- Entity settings: per-user extraction guidance and pipeline config (Phase 2).
CREATE TABLE IF NOT EXISTS entity_settings (
  user_id           TEXT PRIMARY KEY,
  extraction_prompt TEXT,
  memory_kinds      TEXT[],
  decay_enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
