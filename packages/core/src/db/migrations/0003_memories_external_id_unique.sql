/**
 * Partial UNIQUE index enforcing verbatim-ingest idempotency
 * at the schema level.
 *
 * `POST /v1/memories/ingest/quick` with `skip_extraction=true` stamps a
 * caller-owned `metadata.externalId` (the caller's own id). Without a
 * uniqueness guarantee, re-ingesting the same `externalId` inserted a second
 * row, and `GET /v1/memories/by-external-id/:externalId` (ORDER BY created_at
 * DESC LIMIT 1) then resolved non-deterministically among the duplicates.
 *
 * `performStoreVerbatim` now does a check-then-update keyed on
 * `(user_id, metadata->>'externalId')` over LIVE rows. This index makes that
 * invariant a hard constraint: at most ONE live row per
 * `(user_id, metadata->>'externalId')`. It is PARTIAL on the same live-row
 * predicate the lookup uses, so:
 *   - rows WITHOUT an `externalId` are not constrained (NULL excluded);
 *   - soft-deleted / expired / non-active historical rows are excluded, so a
 *     prior generation that was superseded does not block a fresh live row
 *     sharing the same `externalId`.
 *
 * This supersedes the non-unique lookup index from migration 0002: a UNIQUE
 * index serves the same `WHERE user_id = $1 AND metadata->>'externalId' = $2`
 * probe, so the older `idx_memories_user_external_id` is dropped to avoid a
 * redundant duplicate index on the identical expression/predicate. Migrations
 * are append-only — 0002 is left untouched on disk; this file rolls it forward.
 *
 * Idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`);
 * safe to replay. Runs inside the migration runner's single transaction, so
 * no `CONCURRENTLY` — additive index on an existing table, no row rewrite.
 */

DROP INDEX IF EXISTS idx_memories_user_external_id;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_user_external_id_live
  ON memories (user_id, (metadata->>'externalId'))
  WHERE metadata->>'externalId' IS NOT NULL
    AND deleted_at IS NULL
    AND expired_at IS NULL
    AND status = 'active';
