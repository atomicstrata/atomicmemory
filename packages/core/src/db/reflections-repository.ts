/**
 * ReflectionsRepository — CRUD plus cosine-similarity search for the
 * session_reflections table. Each row is an LLM-synthesized observation about
 * a conversation, with citations to the supporting memory ids and an embedding
 * for retrieval-side similarity search.
 *
 * Pure SQL via pg.Pool. No ORM. Mutations fail closed: caller catches errors,
 * we propagate them with the original error attached.
 */
import pg from 'pg';
import pgvector from 'pgvector/pg';

export type ObservationType =
  | 'entity_state'
  | 'event_summary'
  | 'preference'
  | 'contradiction'
  | 'decision'
  | 'numeric_value';

export interface NewReflection {
  userId: string;
  conversationId: string;
  observation: string;
  observationType: ObservationType;
  evidenceMemoryIds: string[];
  embedding: number[];
}

export interface Reflection extends NewReflection {
  id: string;
  createdAt: Date;
}

export class ReflectionsRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Insert multiple reflections in a single transaction. On any error,
   * the entire transaction is rolled back.
   */
  async insertMany(rows: readonly NewReflection[]): Promise<void> {
    if (rows.length === 0) return;
    const sql = `
      INSERT INTO session_reflections
        (user_id, conversation_id, observation, observation_type, evidence_memory_ids, embedding)
      VALUES ($1, $2, $3, $4, $5, $6::vector)
    `;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        await client.query(sql, [
          r.userId,
          r.conversationId,
          r.observation,
          r.observationType,
          r.evidenceMemoryIds,
          pgvector.toSql(r.embedding),
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

  /**
   * Find all reflections for a (userId, conversationId) pair, ordered by creation time.
   */
  async findByConversation(userId: string, conversationId: string): Promise<Reflection[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, observation, observation_type,
              evidence_memory_ids, created_at
       FROM session_reflections
       WHERE user_id = $1 AND conversation_id = $2
       ORDER BY created_at ASC`,
      [userId, conversationId],
    );
    return rows.map(mapRow);
  }

  /**
   * Find the top-K reflections most similar to queryEmbedding for a userId,
   * ordered by cosine distance (closest first).
   */
  async findSimilar(userId: string, queryEmbedding: number[], topK: number): Promise<Reflection[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, observation, observation_type,
              evidence_memory_ids, created_at
       FROM session_reflections
       WHERE user_id = $1
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [userId, pgvector.toSql(queryEmbedding), topK],
    );
    return rows.map(mapRow);
  }
}

/**
 * Map a Postgres query result row to a Reflection object.
 * Excludes the embedding vector from the returned object (not needed for
 * app logic, only for similarity search on insertion/retrieval).
 */
function mapRow(r: pg.QueryResultRow): Reflection {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    observation: r.observation,
    observationType: r.observation_type,
    evidenceMemoryIds: r.evidence_memory_ids,
    embedding: [],
    createdAt: r.created_at,
  };
}
