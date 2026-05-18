/**
 * EntityValuesRepository — CRUD for the entity_values table populated at
 * ingest. Used by the IE/KU literal-value specialist at retrieval.
 */
import pg from 'pg';

export type ValueType = 'date' | 'number' | 'string' | 'duration' | 'list';

export interface NewEntityValue {
  userId: string;
  entity: string;
  attribute: string;
  value: string;
  valueType: ValueType;
  observedAt: Date;
  factId: string;
}

export interface EntityValue extends NewEntityValue {
  id: string;
  createdAt: Date;
}

export class EntityValuesRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertMany(rows: readonly NewEntityValue[]): Promise<void> {
    if (rows.length === 0) return;
    const sql = `
      INSERT INTO entity_values
        (user_id, entity, attribute, value, value_type, observed_at, fact_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        await client.query(sql, [
          r.userId, r.entity, r.attribute, r.value, r.valueType,
          r.observedAt, r.factId,
        ]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Fuzzy lookup: case-insensitive match on (entity, attribute), most recent first. */
  async findLatest(
    userId: string,
    entity: string,
    attribute: string,
  ): Promise<EntityValue | null> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, entity, attribute, value, value_type, observed_at, fact_id, created_at
       FROM entity_values
       WHERE user_id = $1
         AND lower(entity) = lower($2)
         AND lower(attribute) = lower($3)
       ORDER BY observed_at DESC
       LIMIT 1`,
      [userId, entity, attribute],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}

function mapRow(r: pg.QueryResultRow): EntityValue {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    entity: r.entity as string,
    attribute: r.attribute as string,
    value: r.value as string,
    valueType: r.value_type as ValueType,
    observedAt: r.observed_at as Date,
    factId: r.fact_id as string,
    createdAt: r.created_at as Date,
  };
}
