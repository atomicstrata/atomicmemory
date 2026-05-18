-- EAI (Entity-Attribute Index) — Sprint 4 follow-on.
-- Stores (entity, attribute, value) triples extracted at ingest time, indexed
-- for fast lookup by entity name and/or attribute key on queries like
-- "how many X did I do?" or "what is my Y?". Distinct from the entity
-- graph (entities, entity_relations) which captures structural relations.

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
