/**
 * Create the entity co-occurrence graph table the 1.1.0 entities routes query
 * but no prior migration created. In the release-1.1.0 QA run, entities-l2
 * merge / delete / count surfaced generic 500s — `relation "entity_edges"
 * does not exist`.
 *
 * Shape is fixed by `db/repository-entity-graph.ts` (storeEntityEdges /
 * findNeighbors / findMemoriesForEntities / removeEntityEdges) and the
 * `routes/entities.ts` merge + delete handlers:
 *
 *   - The natural key (user_id, entity_a, entity_b, memory_id) IS the PRIMARY
 *     KEY. It backs the `INSERT ... ON CONFLICT (user_id, entity_a, entity_b,
 *     memory_id) DO NOTHING` idempotent upserts and serves the (user_id,
 *     entity_a) prefix lookups, so there is no surrogate id and no separate
 *     UNIQUE. This matters: the table grows ~O(memories x entities^2), so a
 *     redundant surrogate-key index would be pure write/space overhead.
 *   - Canonical ordering (entity_a <= entity_b) is the writer's responsibility:
 *     `buildCanonicalPairs` sorts each pair before insert. We deliberately do
 *     NOT add a `CHECK (entity_a <= entity_b)` constraint: the writer compares
 *     with JavaScript string `<` (UTF-16 code-unit order) while a DB CHECK
 *     compares with the column's collation (locale-sensitive on a non-`C`
 *     database). The two can disagree on case / punctuation / supplementary
 *     characters, which would turn an app-canonicalised pair into a CHECK
 *     violation (500) on legitimate input. The PRIMARY KEY still guarantees at
 *     most one row per exact tuple.
 *   - memory_id FK -> memories(id) ON DELETE CASCADE (matches
 *     first_mention_events / entity_relations) so edges vanish with their
 *     memory and the findNeighbors JOIN on memories stays consistent.
 *
 * NOTE on the other half of the entities-l2 failures (list/get/profile): those
 * order by "most recently active". That is now computed in SQL from an existing
 * write-stamped column — `MAX(created_at)` — in `routes/entities.ts`, so the
 * exposed `updated_at` / `last_active` fields track the last WRITE. Reads are
 * deliberately excluded: `last_accessed_at` is bumped by access tracking, which
 * would churn the ordering on every search/get. We also deliberately do NOT add
 * a `memories.updated_at` column: a NOT NULL backfill would rewrite the entire
 * `memories` table under lock inside the single-transaction migration, and a
 * maintenance trigger would fire on access-tracking updates and conflate reads
 * with edits.
 *
 * Idempotent (IF NOT EXISTS) and append-only; runs inside the migration
 * runner's single transaction, so no CONCURRENTLY.
 */

CREATE TABLE IF NOT EXISTS entity_edges (
  user_id    TEXT NOT NULL,
  entity_a   TEXT NOT NULL,
  entity_b   TEXT NOT NULL,
  memory_id  UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, entity_a, entity_b, memory_id)
);

-- Neighbour lookups match either endpoint: the PRIMARY KEY index covers the
-- (user_id, entity_a) prefix; this index covers (user_id, entity_b). The
-- `entity_a = ANY($2) OR entity_b = ANY($2)` predicate is served by a BitmapOr.
CREATE INDEX IF NOT EXISTS idx_entity_edges_user_b ON entity_edges (user_id, entity_b);
-- removeEntityEdges(memory_id) deletes by memory_id, and the FK ON DELETE
-- CASCADE needs the back-reference index to avoid a seq scan per memory delete.
CREATE INDEX IF NOT EXISTS idx_entity_edges_memory ON entity_edges (memory_id);
