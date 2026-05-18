-- 20260512_entity_cards.sql
-- BEAM-0.85 — always-on per-entity summary card channel (Honcho parity).
--
-- One row per (user_id, conversation_id, entity_name) holds the durable
-- summary card the answer LLM reads on every question about that entity.
-- The Reflect worker (Sonnet 4.5) maintains the card by re-synthesizing
-- it from new observations alongside the prior card text.

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
