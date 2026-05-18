-- Sprint 3 v1.5 (H2): user-profile channel.
-- One row per user holds the synthesized profile that is pinned to
-- every answer prompt. Updated by user-profile-builder.ts after each
-- ingest that stores >= 3 new facts.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id           TEXT PRIMARY KEY,
  profile_text      TEXT NOT NULL,
  source_memory_ids TEXT[] NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_profiles_updated_at_idx
  ON user_profiles (updated_at DESC);
