/**
 * Entity graph repository — stores structured entities extracted from memories,
 * handles entity resolution (dedup by embedding similarity + type match), and
 * provides entity-aware retrieval expansion for multi-hop queries.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';
import {
  type EntityRow,
  type EntityRelationRow,
  type EntityType,
  type RelationType,
  normalizeEntityRow,
  parseEmbedding,
} from './repository-types.js';

/** Threshold above which two entities with the same type are considered duplicates. */
const ENTITY_RESOLUTION_THRESHOLD = config.entityResolutionThreshold;

/**
 * Normalize entity names for deterministic canonicalization before embedding
 * similarity is consulted. This is intentionally conservative: punctuation and
 * spacing differences collapse, but semantic rewrites do not.
 */
/** Extract IDs from query rows and filter out excluded ones. */
function filterExcludedIds(rows: Record<string, unknown>[], idField: string, excludeIds: Set<string>): string[] {
  return rows
    .map((r) => r[idField] as string)
    .filter((id) => !excludeIds.has(id));
}

/**
 * Run a query that returns distinct IDs from a join, then exclude already-seen IDs.
 * Shared by findMemoryIdsByEntities and findRelatedEntityIds.
 */
async function queryDistinctIdsWithExclusion(
  pool: pg.Pool,
  sql: string,
  params: unknown[],
  idField: string,
  excludeIds: Set<string>,
): Promise<string[]> {
  const result = await pool.query(sql, params);
  return filterExcludedIds(result.rows, idField, excludeIds);
}

function normalizeEntityName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || name.trim().toLowerCase();
}

export interface EntityInput {
  userId: string;
  name: string;
  entityType: EntityType;
  embedding: number[];
  aliasNames?: string[];
}

export class EntityRepository {
  constructor(private pool: pg.Pool) {}

  /**
   * Shared implementation: run a distinct-ID query and filter out excluded IDs.
   * Both findMemoryIdsByEntities and findRelatedEntityIds delegate here.
   */
  private async findRelatedIdsExcluding(
    sql: string,
    idField: string,
    userId: string,
    entityIds: string[],
    excludeIds: Set<string>,
    limit: number,
  ): Promise<string[]> {
    if (entityIds.length === 0) return [];
    return queryDistinctIdsWithExclusion(
      this.pool, sql, [userId, entityIds, limit], idField, excludeIds,
    );
  }

  /**
   * Resolve-or-create: find an existing entity with the same type and embedding
   * similarity above threshold, or create a new one. Returns the entity ID.
   */
  async resolveEntity(input: EntityInput): Promise<string> {
    return this.resolveEntityWithClient(this.pool as unknown as pg.PoolClient, input);
  }

  async resolveEntityWithClient(client: pg.PoolClient, input: EntityInput): Promise<string> {
    const deterministicMatch = await this.findDeterministicEntity(
      input.userId,
      input.entityType,
      input.name,
      client,
    );
    if (deterministicMatch) {
      await this.mergeAlias(client, deterministicMatch.id, input.name);
      return deterministicMatch.id;
    }

    const match = await this.findSimilarEntity(
      client, input.userId, input.entityType, input.embedding,
    );

    if (match) {
      await this.mergeAlias(client, match.id, input.name);
      return match.id;
    }

    return this.createEntity(client, input);
  }

  async findDeterministicEntity(
    userId: string,
    entityType: EntityType,
    name: string,
    client: pg.PoolClient | pg.Pool = this.pool,
  ): Promise<EntityRow | null> {
    const normalizedName = normalizeEntityName(name);
    const result = await client.query(
      `SELECT *
       FROM entities
       WHERE user_id = $1
         AND entity_type = $2
         AND (
           normalized_name = $3
           OR $3 = ANY(normalized_alias_names)
         )
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId, entityType, normalizedName],
    );
    return result.rows[0] ? normalizeEntityRow(result.rows[0]) : null;
  }

  /**
   * Find the most similar entity of the same type above the resolution threshold.
   */
  async findSimilarEntity(
    client: pg.PoolClient | pg.Pool,
    userId: string,
    entityType: EntityType,
    embedding: number[],
  ): Promise<EntityRow | null> {
    const result = await client.query(
      `SELECT *, 1 - (embedding <=> $1) AS similarity
       FROM entities
       WHERE user_id = $2 AND entity_type = $3
         AND 1 - (embedding <=> $1) >= $4
       ORDER BY similarity DESC
       LIMIT 1`,
      [pgvector.toSql(embedding), userId, entityType, ENTITY_RESOLUTION_THRESHOLD],
    );
    return result.rows[0] ? normalizeEntityRow(result.rows[0]) : null;
  }

  /**
   * Create a new entity record.
   */
  async createEntity(client: pg.PoolClient | pg.Pool, input: EntityInput): Promise<string> {
    const normalizedName = normalizeEntityName(input.name);
    const aliasNames = [...new Set((input.aliasNames ?? []).filter((alias) => alias !== input.name))];
    const normalizedAliasNames = [...new Set(
      aliasNames
        .map(normalizeEntityName)
        .filter((alias) => Boolean(alias) && alias !== normalizedName),
    )];
    const result = await client.query(
      `INSERT INTO entities (
         user_id, name, normalized_name, entity_type, embedding, alias_names, normalized_alias_names
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.userId,
        input.name,
        normalizedName,
        input.entityType,
        pgvector.toSql(input.embedding),
        aliasNames,
        normalizedAliasNames,
      ],
    );
    return result.rows[0].id;
  }

  /**
   * Add a name alias to an existing entity if not already present.
   */
  async mergeAlias(client: pg.PoolClient | pg.Pool, entityId: string, alias: string): Promise<void> {
    const normalizedAlias = normalizeEntityName(alias);
    await client.query(
      `UPDATE entities
       SET alias_names = CASE
         WHEN $2 = ANY(alias_names) OR lower($2) = lower(name) OR $3 = ANY(normalized_alias_names) THEN alias_names
         ELSE array_append(alias_names, $2)
       END,
       normalized_alias_names = CASE
         WHEN $3 = normalized_name OR $3 = ANY(normalized_alias_names) THEN normalized_alias_names
         ELSE array_append(normalized_alias_names, $3)
       END,
       updated_at = NOW()
       WHERE id = $1`,
      [entityId, alias, normalizedAlias],
    );
  }

  /**
   * Link a memory to an entity.
   */
  async linkMemoryToEntity(memoryId: string, entityId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_entities (memory_id, entity_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [memoryId, entityId],
    );
  }

  /**
   * Find all memory IDs linked to a set of entity IDs. Returns unique IDs
   * excluding any in the exclude set.
   */
  async findMemoryIdsByEntities(
    userId: string,
    entityIds: string[],
    excludeIds: Set<string>,
    limit: number,
  ): Promise<string[]> {
    return this.findRelatedIdsExcluding(
      `SELECT DISTINCT me.memory_id
       FROM memory_entities me
       JOIN memories m ON m.id = me.memory_id AND m.deleted_at IS NULL AND m.expired_at IS NULL AND m.workspace_id IS NULL
       JOIN entities e ON e.id = me.entity_id
       WHERE e.user_id = $1
         AND m.user_id = $1
         AND me.entity_id = ANY($2)
       LIMIT $3`,
      'memory_id',
      userId, entityIds, excludeIds, limit,
    );
  }

  /**
   * Find entities by exact or substring name match (case-insensitive).
   * Used for co-retrieval when a query mentions a known entity by name.
   */
  async findEntitiesByName(
    userId: string,
    name: string,
    limit: number = 10,
  ): Promise<EntityRow[]> {
    const normalizedName = normalizeEntityName(name);
    const result = await this.pool.query(
      `SELECT * FROM entities
       WHERE user_id = $1
         AND (
           normalized_name = $2
           OR $2 = ANY(normalized_alias_names)
         )
       ORDER BY created_at ASC
       LIMIT $3`,
      [userId, normalizedName, limit],
    );
    return result.rows.map(normalizeEntityRow);
  }

  /**
   * Find entities matching a query embedding (for query-time entity extraction).
   */
  async searchEntities(
    userId: string,
    queryEmbedding: number[],
    limit: number,
    minSimilarity: number = 0.7,
  ): Promise<Array<EntityRow & { similarity: number }>> {
    const result = await this.pool.query(
      `SELECT *, 1 - (embedding <=> $1) AS similarity
       FROM entities
       WHERE user_id = $2
         AND 1 - (embedding <=> $1) >= $4
       ORDER BY similarity DESC
       LIMIT $3`,
      [pgvector.toSql(queryEmbedding), userId, limit, minSimilarity],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      ...normalizeEntityRow(row),
      similarity: row.similarity as number,
    }));
  }

  /**
   * Get all entities linked to a specific memory.
   */
  async getEntitiesForMemory(memoryId: string): Promise<EntityRow[]> {
    const result = await this.pool.query(
      `SELECT e.* FROM entities e
       JOIN memory_entities me ON me.entity_id = e.id
       WHERE me.memory_id = $1`,
      [memoryId],
    );
    return result.rows.map(normalizeEntityRow);
  }

  /**
   * Get an entity by ID.
   */
  async getEntity(id: string): Promise<EntityRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM entities WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? normalizeEntityRow(result.rows[0]) : null;
  }

  /**
   * Count entities for a user.
   */
  async countEntities(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM entities WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0].count;
  }

  // ─── Relations ───────────────────────────────────────────────────────

  /**
   * Create or update a relation between two entities. Upserts on the
   * (source, target, type) unique constraint, updating confidence if higher.
   */
  async upsertRelation(input: {
    userId: string;
    sourceEntityId: string;
    targetEntityId: string;
    relationType: RelationType;
    sourceMemoryId?: string;
    confidence?: number;
  }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO entity_relations
         (user_id, source_entity_id, target_entity_id, relation_type, source_memory_id, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_entity_id, target_entity_id, relation_type)
       DO UPDATE SET
         confidence = GREATEST(entity_relations.confidence, EXCLUDED.confidence),
         source_memory_id = EXCLUDED.source_memory_id
       RETURNING id`,
      [
        input.userId,
        input.sourceEntityId,
        input.targetEntityId,
        input.relationType,
        input.sourceMemoryId ?? null,
        input.confidence ?? 1.0,
      ],
    );
    return result.rows[0].id;
  }

  /**
   * Find all entities related to a set of entity IDs (1-hop traversal).
   * Follows relations in both directions to find connected entities.
   */
  async findRelatedEntityIds(
    userId: string,
    entityIds: string[],
    excludeIds: Set<string>,
    limit: number,
  ): Promise<string[]> {
    return this.findRelatedIdsExcluding(
      `SELECT DISTINCT entity_id FROM (
         SELECT target_entity_id AS entity_id
         FROM entity_relations
         WHERE user_id = $1 AND source_entity_id = ANY($2) AND valid_to IS NULL
         UNION
         SELECT source_entity_id AS entity_id
         FROM entity_relations
         WHERE user_id = $1 AND target_entity_id = ANY($2) AND valid_to IS NULL
       ) AS related
       LIMIT $3`,
      'entity_id',
      userId, entityIds, excludeIds, limit,
    );
  }

  /**
   * Get all relations for an entity (both directions).
   */
  async getRelationsForEntity(entityId: string): Promise<EntityRelationRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM entity_relations
       WHERE (source_entity_id = $1 OR target_entity_id = $1)
         AND valid_to IS NULL
       ORDER BY created_at DESC`,
      [entityId],
    );
    return result.rows as EntityRelationRow[];
  }

  /**
   * Get active relations supported by the entities linked to a specific memory.
   * This follows the linked entity set instead of relying solely on the first
   * source_memory_id, so current claims can still recover a slot even when the
   * same relation was first observed in an older memory.
   */
  async getRelationsForMemory(
    userId: string,
    memoryId: string,
  ): Promise<EntityRelationRow[]> {
    const result = await this.pool.query(
      `SELECT er.*
       FROM entity_relations er
       JOIN memory_entities me_source
         ON me_source.entity_id = er.source_entity_id
        AND me_source.memory_id = $2
       JOIN memory_entities me_target
         ON me_target.entity_id = er.target_entity_id
        AND me_target.memory_id = $2
       WHERE er.user_id = $1
         AND valid_to IS NULL
       ORDER BY (er.source_memory_id = $2) DESC,
                er.relation_type ASC,
                er.source_entity_id ASC,
                er.target_entity_id ASC`,
      [userId, memoryId],
    );
    return result.rows as EntityRelationRow[];
  }

  /**
   * Invalidate a relation by setting valid_to.
   */
  async invalidateRelation(relationId: string, validTo: Date = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE entity_relations SET valid_to = $1 WHERE id = $2`,
      [validTo, relationId],
    );
  }

  /**
   * Count active relations for a user.
   */
  async countRelations(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM entity_relations
       WHERE user_id = $1 AND valid_to IS NULL`,
      [userId],
    );
    return result.rows[0].count;
  }

  /**
   * Delete all entities, relations, and memory_entities for a user or all users.
   */
  async deleteAll(userId?: string): Promise<void> {
    if (userId) {
      await this.pool.query(`DELETE FROM entity_relations WHERE user_id = $1`, [userId]);
      await this.pool.query(`DELETE FROM memory_entities WHERE entity_id IN (SELECT id FROM entities WHERE user_id = $1)`, [userId]);
      await this.pool.query(`DELETE FROM entities WHERE user_id = $1`, [userId]);
    } else {
      await this.pool.query(`DELETE FROM entity_relations`);
      await this.pool.query(`DELETE FROM memory_entities`);
      await this.pool.query(`DELETE FROM entities`);
    }
  }
}
