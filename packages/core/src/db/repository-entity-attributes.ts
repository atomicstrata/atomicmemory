/**
 * Repository for the entity_attributes table (EAI — Sprint 4).
 *
 * Stores (entity, attribute, value) triples. Read path: look up triples
 * for a user by entity_name (fuzzy/lowercase) and/or attribute_key.
 * Write path: bulk insert from the extractor service.
 */
import type pg from 'pg';

export type ValueType = 'number' | 'string' | 'list' | 'boolean' | 'date';

export interface EntityAttributeRow {
  id: string;
  user_id: string;
  entity_name: string;
  attribute_key: string;
  attribute_value: string;
  value_type: ValueType;
  source_memory_id: string | null;
  observed_at: Date;
  created_at: Date;
}

export interface EntityAttributeInput {
  userId: string;
  entityName: string;
  attributeKey: string;
  attributeValue: string;
  valueType: ValueType;
  sourceMemoryId?: string | null;
  observedAt?: Date | null;
}

export class EntityAttributesRepository {
  constructor(private readonly pool: pg.Pool) {}

  async bulkInsert(rows: EntityAttributeInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    rows.forEach((r, i) => {
      const base = i * 7;
      placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
      values.push(
        r.userId,
        r.entityName,
        r.attributeKey,
        r.attributeValue,
        r.valueType,
        r.sourceMemoryId ?? null,
        r.observedAt ?? new Date(),
      );
    });
    const sql =
      'INSERT INTO entity_attributes (user_id, entity_name, attribute_key, attribute_value, value_type, source_memory_id, observed_at) VALUES ' +
      placeholders.join(',');
    const result = await this.pool.query(sql, values);
    return result.rowCount ?? 0;
  }

  /** Lookup attributes by entity name (case-insensitive). Returns most-recent first. */
  async findByEntity(userId: string, entityName: string, limit = 20): Promise<EntityAttributeRow[]> {
    const result = await this.pool.query<EntityAttributeRow>(
      `SELECT id, user_id, entity_name, attribute_key, attribute_value, value_type,
              source_memory_id, observed_at, created_at
       FROM entity_attributes
       WHERE user_id = $1 AND lower(entity_name) = lower($2)
       ORDER BY observed_at DESC
       LIMIT $3`,
      [userId, entityName, limit],
    );
    return result.rows;
  }

  /** Lookup attributes by attribute key (case-insensitive). Useful for "how many X" queries. */
  async findByAttribute(userId: string, attributeKey: string, limit = 20): Promise<EntityAttributeRow[]> {
    const result = await this.pool.query<EntityAttributeRow>(
      `SELECT id, user_id, entity_name, attribute_key, attribute_value, value_type,
              source_memory_id, observed_at, created_at
       FROM entity_attributes
       WHERE user_id = $1 AND lower(attribute_key) = lower($2)
       ORDER BY observed_at DESC
       LIMIT $3`,
      [userId, attributeKey, limit],
    );
    return result.rows;
  }

  /** Combined lookup: entity OR attribute matches; useful when query mentions both. */
  async findByEntityOrAttribute(
    userId: string,
    tokens: string[],
    limit = 20,
  ): Promise<EntityAttributeRow[]> {
    if (tokens.length === 0) return [];
    const params: unknown[] = [userId];
    const orClauses: string[] = [];
    tokens.forEach((t) => {
      params.push(t.toLowerCase());
      orClauses.push(`lower(entity_name) = $${params.length} OR lower(attribute_key) = $${params.length}`);
    });
    params.push(limit);
    const sql =
      `SELECT id, user_id, entity_name, attribute_key, attribute_value, value_type,
              source_memory_id, observed_at, created_at
       FROM entity_attributes
       WHERE user_id = $1 AND (${orClauses.join(' OR ')})
       ORDER BY observed_at DESC
       LIMIT $${params.length}`;
    const result = await this.pool.query<EntityAttributeRow>(sql, params);
    return result.rows;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.pool.query('DELETE FROM entity_attributes WHERE user_id = $1', [userId]);
    return result.rowCount ?? 0;
  }
}
