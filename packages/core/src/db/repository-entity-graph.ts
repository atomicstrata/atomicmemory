/**
 * Repository for entity co-occurrence graph operations.
 * Stores pairwise entity edges per memory and supports neighbor lookups
 * for spreading activation retrieval.
 */

import pg from 'pg';

export interface EntityEdge {
  entityA: string;
  entityB: string;
  memoryId: string;
}

export interface NeighborResult {
  entity: string;
  memoryId: string;
}

/** Store pairwise entity edges for a single memory. */
export async function storeEntityEdges(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  entities: string[],
): Promise<number> {
  if (entities.length < 2) return 0;

  const pairs = buildCanonicalPairs(entities);
  if (pairs.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const [a, b] of pairs) {
    placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3})`);
    values.push(userId, a, b, memoryId);
    paramIndex += 4;
  }

  const sql = `
    INSERT INTO entity_edges (user_id, entity_a, entity_b, memory_id)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (user_id, entity_a, entity_b, memory_id) DO NOTHING
  `;

  await pool.query(sql, values);
  return pairs.length;
}

/** Remove all entity edges for a memory (used before UPDATE/SUPERSEDE). */
export async function removeEntityEdges(
  pool: pg.Pool,
  memoryId: string,
): Promise<void> {
  await pool.query('DELETE FROM entity_edges WHERE memory_id = $1', [memoryId]);
}

/**
 * Find all neighbors of a set of entities (one hop).
 * Returns entities connected to any seed entity, along with which memory links them.
 */
export async function findNeighbors(
  pool: pg.Pool,
  userId: string,
  seedEntities: string[],
): Promise<NeighborResult[]> {
  if (seedEntities.length === 0) return [];

  const result = await pool.query(
    `SELECT DISTINCT
       CASE WHEN entity_a = ANY($2) THEN entity_b ELSE entity_a END AS entity,
       e.memory_id
     FROM entity_edges e
     JOIN memories m ON m.id = e.memory_id AND m.deleted_at IS NULL
     WHERE e.user_id = $1
       AND (e.entity_a = ANY($2) OR e.entity_b = ANY($2))`,
    [userId, seedEntities],
  );

  return result.rows;
}

/**
 * Find all memory IDs linked to a set of entities (direct lookup, no traversal).
 * Used to score memories by accumulated activation after spreading.
 */
export async function findMemoriesForEntities(
  pool: pg.Pool,
  userId: string,
  entities: string[],
): Promise<Array<{ memoryId: string; entity: string }>> {
  if (entities.length === 0) return [];

  const result = await pool.query(
    `SELECT DISTINCT e.memory_id AS "memoryId",
       CASE WHEN e.entity_a = ANY($2) THEN e.entity_a ELSE e.entity_b END AS entity
     FROM entity_edges e
     JOIN memories m ON m.id = e.memory_id AND m.deleted_at IS NULL
     WHERE e.user_id = $1
       AND (e.entity_a = ANY($2) OR e.entity_b = ANY($2))`,
    [userId, entities],
  );

  return result.rows;
}

/** Delete all entity edges for a user (used in eval cleanup). */
async function deleteAllEntityEdges(
  pool: pg.Pool,
  userId?: string,
): Promise<void> {
  if (userId) {
    await pool.query('DELETE FROM entity_edges WHERE user_id = $1', [userId]);
  } else {
    await pool.query('TRUNCATE entity_edges CASCADE');
  }
}

/**
 * Build canonical pairs from entity list.
 * Ensures entity_a < entity_b for consistent deduplication.
 */
function buildCanonicalPairs(entities: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      pairs.push(a < b ? [a, b] : [b, a]);
    }
  }
  return pairs;
}
