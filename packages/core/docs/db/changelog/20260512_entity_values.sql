-- Phase 2 BEAM-0.85: literal-value extraction for IE/KU specialist.
-- Captures (entity, attribute, value) triples from each ingested fact so
-- factual questions can be answered via SQL lookup, not paraphrased LLM
-- output.

CREATE TABLE IF NOT EXISTS entity_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,            -- e.g. "first sprint", "API key", "test coverage"
  attribute TEXT NOT NULL,          -- e.g. "end date", "daily quota", "percentage"
  value TEXT NOT NULL,              -- LITERAL value as it appears: "March 29", "1,200 calls per day", "78%"
  value_type TEXT NOT NULL CHECK (value_type IN ('date', 'number', 'string', 'duration', 'list')),
  observed_at TIMESTAMPTZ NOT NULL,
  fact_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_entity_values_lookup
  ON entity_values (user_id, lower(entity), lower(attribute), observed_at DESC);

CREATE INDEX IF NOT EXISTS ix_entity_values_fact
  ON entity_values (fact_id);
