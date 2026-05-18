/**
 * Lesson repository — CRUD and similarity search for detected failure patterns.
 *
 * Lessons capture attack/failure patterns from sanitization blocks, trust
 * violations, contradictions, and user reports. Pre-retrieval checks query
 * lessons by embedding similarity to block known-bad patterns before they
 * reach the user.
 *
 * Phase 6 (A-MemGuard): self-reinforcing defense via pattern accumulation.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';
import { config } from '../config.js';

export type LessonType =
  | 'injection_blocked'
  | 'false_memory'
  | 'contradiction_pattern'
  | 'user_reported'
  | 'consensus_violation'
  | 'trust_violation';

export type LessonSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface LessonRow {
  id: string;
  user_id: string;
  lesson_type: LessonType;
  pattern: string;
  embedding: number[];
  source_memory_ids: string[];
  source_query: string | null;
  severity: LessonSeverity;
  active: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface CreateLessonInput {
  userId: string;
  lessonType: LessonType;
  pattern: string;
  embedding: number[];
  sourceMemoryIds?: string[];
  sourceQuery?: string;
  severity?: LessonSeverity;
  metadata?: Record<string, unknown>;
}

export interface LessonMatch {
  lesson: LessonRow;
  similarity: number;
}

export class LessonRepository {
  constructor(private pool: pg.Pool) {}

  async createLesson(input: CreateLessonInput): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO lessons (user_id, lesson_type, pattern, embedding, source_memory_ids, source_query, severity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.userId,
        input.lessonType,
        input.pattern,
        pgvector.toSql(input.embedding),
        input.sourceMemoryIds ?? [],
        input.sourceQuery ?? null,
        input.severity ?? 'medium',
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return result.rows[0].id;
  }

  async findSimilarLessons(
    userId: string,
    embedding: number[],
    threshold: number,
    limit: number = 5,
  ): Promise<LessonMatch[]> {
    const result = await this.pool.query(
      `SELECT *, 1 - (embedding <=> $1) AS similarity
       FROM lessons
       WHERE user_id = $2 AND active = true
         AND 1 - (embedding <=> $1) >= $3
       ORDER BY similarity DESC
       LIMIT $4`,
      [pgvector.toSql(embedding), userId, threshold, limit],
    );
    return result.rows.map((row) => ({
      lesson: parseRow(row),
      similarity: parseFloat(row.similarity),
    }));
  }

  async getLessonsByUser(userId: string, activeOnly: boolean = true): Promise<LessonRow[]> {
    const activeClause = activeOnly ? 'AND active = true' : '';
    const result = await this.pool.query(
      `SELECT * FROM lessons WHERE user_id = $1 ${activeClause} ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map(parseRow);
  }

  async getLessonsByType(userId: string, lessonType: LessonType): Promise<LessonRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM lessons WHERE user_id = $1 AND lesson_type = $2 AND active = true ORDER BY created_at DESC`,
      [userId, lessonType],
    );
    return result.rows.map(parseRow);
  }

  async deactivateLesson(userId: string, lessonId: string): Promise<void> {
    await this.pool.query(
      `UPDATE lessons SET active = false WHERE id = $1 AND user_id = $2`,
      [lessonId, userId],
    );
  }

  async countActiveLessons(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM lessons WHERE user_id = $1 AND active = true`,
      [userId],
    );
    return result.rows[0].count;
  }

  async deleteAll(): Promise<void> {
    await this.pool.query('DELETE FROM lessons');
  }
}

function parseRow(row: Record<string, unknown>): LessonRow {
  const rawEmb = row.embedding;
  let embedding: number[];
  if (typeof rawEmb === 'string') {
    embedding = rawEmb.replace(/[\[\]]/g, '').split(',').map(Number);
  } else if (Array.isArray(rawEmb)) {
    embedding = rawEmb as number[];
  } else {
    embedding = Array(config.embeddingDimensions).fill(0);
  }

  return {
    id: row.id as string,
    user_id: row.user_id as string,
    lesson_type: row.lesson_type as LessonType,
    pattern: row.pattern as string,
    embedding,
    source_memory_ids: (row.source_memory_ids as string[]) ?? [],
    source_query: (row.source_query as string) ?? null,
    severity: row.severity as LessonSeverity,
    active: row.active as boolean,
    metadata: (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata ?? {}) as Record<string, unknown>,
    created_at: row.created_at as Date,
  };
}
