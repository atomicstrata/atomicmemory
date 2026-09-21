-- Durable outbox for connected-local Cloud trace upload.

CREATE TABLE IF NOT EXISTS cloud_trace_outbox (
  event_id UUID PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('pending', 'claimed', 'sent', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  dead_letter_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS cloud_trace_outbox_pending_idx
  ON cloud_trace_outbox (delivery_state, next_attempt_at)
  WHERE delivery_state IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS cloud_trace_outbox_sent_retention_idx
  ON cloud_trace_outbox (sent_at)
  WHERE delivery_state = 'sent';
