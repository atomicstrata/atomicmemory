/**
 * Postgres-backed work queue for the async Reflect step.
 *
 * Idempotent enqueue: a unique partial index on (user_id, conversation_id)
 * WHERE status IN ('pending','in_progress') guarantees one in-flight job per
 * conversation at a time. Re-enqueue after completion creates a new job (the
 * unique index excludes 'completed' and 'failed').
 *
 * The worker (services/reflect-jobs.ts) drives the lifecycle: fetchPending →
 * markInProgress → run reflect → markCompleted | markFailed.
 */
import pg from 'pg';

export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ReflectionJob {
  id: string;
  userId: string;
  conversationId: string;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  lastTriedAt: Date | null;
}

export class ReflectionJobsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(userId: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO reflection_jobs (user_id, conversation_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, conversationId],
    );
  }

  async fetchPending(limit: number): Promise<ReflectionJob[]> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, status, attempts, last_error,
              created_at, last_tried_at
       FROM reflection_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(mapJob);
  }

  async markInProgress(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reflection_jobs
       SET status = 'in_progress', attempts = attempts + 1, last_tried_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markCompleted(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reflection_jobs SET status = 'completed' WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE reflection_jobs SET status = 'failed', last_error = $2 WHERE id = $1`,
      [id, error],
    );
  }

  async findById(id: string): Promise<ReflectionJob | null> {
    const { rows } = await this.pool.query(
      `SELECT id, user_id, conversation_id, status, attempts, last_error,
              created_at, last_tried_at
       FROM reflection_jobs WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }
}

function mapJob(r: pg.QueryResultRow): ReflectionJob {
  return {
    id: r.id,
    userId: r.user_id,
    conversationId: r.conversation_id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    lastTriedAt: r.last_tried_at,
  };
}
