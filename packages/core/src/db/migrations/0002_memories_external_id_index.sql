/**
 * Expression index supporting the reverse lookup
 * `GET /v1/memories/by-external-id/:externalId`.
 *
 * The route resolves a memory from a caller-owned `metadata.externalId`
 * (the caller's own id stamped on quick-ingest) via
 * `WHERE user_id = $1 AND metadata->>'externalId' = $2`. Without an index
 * that predicate forces a scan of every live row for the user. This partial
 * expression index on `(user_id, (metadata->>'externalId'))` — restricted to
 * the same live-row predicate the query uses — makes the lookup a direct
 * index probe and keeps the index small (only rows that actually carry an
 * externalId and are active participate).
 *
 * Idempotent (`CREATE INDEX IF NOT EXISTS`); safe to replay on every boot.
 * Runs inside the migration runner's single transaction, so no
 * `CONCURRENTLY` — this is an additive index on an existing table and does
 * not touch or rewrite any rows.
 */

CREATE INDEX IF NOT EXISTS idx_memories_user_external_id
  ON memories (user_id, (metadata->>'externalId'))
  WHERE metadata->>'externalId' IS NOT NULL
    AND deleted_at IS NULL
    AND expired_at IS NULL
    AND status = 'active';
