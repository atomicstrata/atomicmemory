/**
 * Repository for hierarchical-retrieval session + conversation summaries.
 * Schema lives in src/db/schema.sql under "Hierarchical Retrieval" section.
 * Activated only when `HIERARCHICAL_RETRIEVAL_ENABLED=true`.
 *
 * Reads use pgvector cosine distance (`embedding <=> $1`) returning
 * `1 - distance` as similarity. The `pgvector` package converts JS
 * arrays to the SQL vector literal at call time.
 */

import pg from 'pg';

export interface AppendSessionSummaryInput {
  userId: string;
  sessionId: string;
  conversationId: string;
  sessionIndex: number;
  summaryText: string;
  summaryEmbedding: number[];
  topics: string[];
  factCount: number;
  occurredStart?: Date | null;
  occurredEnd?: Date | null;
  workspaceId?: string | null;
  agentId?: string | null;
}

export interface AppendConvSummaryInput {
  userId: string;
  conversationId: string;
  summaryText: string;
  summaryEmbedding: number[];
  sessionCount: number;
  factCount: number;
  occurredStart?: Date | null;
  occurredEnd?: Date | null;
  workspaceId?: string | null;
  agentId?: string | null;
}

export interface ConvSummaryHit {
  id: string;
  conversationId: string;
  similarity: number;
  summaryText: string;
}

export interface SessionSummaryHit {
  id: string;
  sessionId: string;
  conversationId: string;
  sessionIndex: number;
  similarity: number;
  summaryText: string;
}

export class SummariesRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Insert a session summary; returns the new row id. */
  async appendSessionSummary(input: AppendSessionSummaryInput): Promise<string> {
    const pgvector = await import('pgvector/pg');
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO session_summaries
        (user_id, session_id, conversation_id, session_index, summary_text,
         summary_embedding, topics, fact_count, occurred_start, occurred_end,
         workspace_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.userId,
        input.sessionId,
        input.conversationId,
        input.sessionIndex,
        input.summaryText,
        pgvector.default.toSql(input.summaryEmbedding),
        input.topics,
        input.factCount,
        input.occurredStart ?? null,
        input.occurredEnd ?? null,
        input.workspaceId ?? null,
        input.agentId ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  /** Insert a conversation summary; returns the new row id. */
  async appendConvSummary(input: AppendConvSummaryInput): Promise<string> {
    const pgvector = await import('pgvector/pg');
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO conv_summaries
        (user_id, conversation_id, summary_text, summary_embedding,
         session_count, fact_count, occurred_start, occurred_end,
         workspace_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.userId,
        input.conversationId,
        input.summaryText,
        pgvector.default.toSql(input.summaryEmbedding),
        input.sessionCount,
        input.factCount,
        input.occurredStart ?? null,
        input.occurredEnd ?? null,
        input.workspaceId ?? null,
        input.agentId ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  /** Stage 1: top-K conversation summaries by query-embedding similarity. */
  async searchTopConvSummaries(
    userId: string,
    queryEmbedding: number[],
    topK: number,
  ): Promise<ConvSummaryHit[]> {
    const pgvector = await import('pgvector/pg');
    const result = await this.pool.query<{
      id: string;
      conversation_id: string;
      similarity: number;
      summary_text: string;
    }>(
      `SELECT id, conversation_id, summary_text,
              1 - (summary_embedding <=> $1) AS similarity
       FROM conv_summaries
       WHERE user_id = $2
       ORDER BY summary_embedding <=> $1
       LIMIT $3`,
      [pgvector.default.toSql(queryEmbedding), userId, topK],
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      similarity: Number(row.similarity),
      summaryText: row.summary_text,
    }));
  }

  /**
   * Stage 2: top-K session summaries by query-embedding similarity, filtered
   * to a set of conversation IDs (typically the matches from stage 1).
   */
  async searchTopSessionSummaries(
    userId: string,
    conversationIds: string[],
    queryEmbedding: number[],
    topK: number,
  ): Promise<SessionSummaryHit[]> {
    if (conversationIds.length === 0) return [];
    const pgvector = await import('pgvector/pg');
    const result = await this.pool.query<{
      id: string;
      session_id: string;
      conversation_id: string;
      session_index: number;
      similarity: number;
      summary_text: string;
    }>(
      `SELECT id, session_id, conversation_id, session_index, summary_text,
              1 - (summary_embedding <=> $1) AS similarity
       FROM session_summaries
       WHERE user_id = $2 AND conversation_id = ANY($3::text[])
       ORDER BY summary_embedding <=> $1
       LIMIT $4`,
      [pgvector.default.toSql(queryEmbedding), userId, conversationIds, topK],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      conversationId: row.conversation_id,
      sessionIndex: row.session_index,
      similarity: Number(row.similarity),
      summaryText: row.summary_text,
    }));
  }

  /**
   * Stage 3: expand from a set of session_ids to atomic-memory ids by
   * joining through episodes. The 5th RRF arm hands these ids to the
   * existing rank pipeline.
   */
  async getMemoryIdsForSessions(
    userId: string,
    sessionIds: string[],
    limit: number,
  ): Promise<string[]> {
    if (sessionIds.length === 0) return [];
    const result = await this.pool.query<{ id: string }>(
      `SELECT m.id
       FROM memories m
       JOIN episodes e ON m.episode_id = e.id
       WHERE m.user_id = $1
         AND e.session_id = ANY($2::text[])
         AND m.deleted_at IS NULL
         AND m.expired_at IS NULL
       ORDER BY m.created_at DESC
       LIMIT $3`,
      [userId, sessionIds, limit],
    );
    return result.rows.map((r) => r.id);
  }

  /** Test/dev helper. */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM session_summaries WHERE user_id = $1`, [userId]);
    await this.pool.query(`DELETE FROM conv_summaries WHERE user_id = $1`, [userId]);
  }
}
