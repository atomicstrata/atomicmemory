/**
 * Repository operations for deferred AUDN reconciliation.
 *
 * When deferred AUDN is enabled, facts with conflict candidates in the
 * 0.7–0.95 similarity range are stored as ADD immediately and marked
 * with deferred_audn=true + serialized candidates. A background
 * reconciliation pass resolves these via the full LLM AUDN pipeline.
 */

import type pg from 'pg';

/** Serialized candidate stored alongside a deferred memory. */
export interface DeferredCandidate {
  id: string;
  content: string;
  similarity: number;
}

/** A memory that needs deferred AUDN reconciliation. */
export interface DeferredMemory {
  id: string;
  userId: string;
  content: string;
  candidates: DeferredCandidate[];
  createdAt: Date;
}

/** Store a memory as deferred: set flag and serialize candidates. */
export async function markMemoryDeferred(
  pool: pg.Pool,
  memoryId: string,
  candidates: DeferredCandidate[],
): Promise<void> {
  await pool.query(
    `UPDATE memories SET deferred_audn = true, audn_candidates = $2
     WHERE id = $1`,
    [memoryId, JSON.stringify(candidates)],
  );
}

/** Find up to `limit` memories pending deferred AUDN for a user. */
export async function findDeferredMemories(
  pool: pg.Pool,
  userId: string,
  limit: number,
): Promise<DeferredMemory[]> {
  const result = await pool.query(
    `SELECT id, user_id, content, audn_candidates, created_at
     FROM memories
     WHERE user_id = $1 AND deferred_audn = true AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    content: row.content,
    candidates: parseCandidates(row.audn_candidates),
    createdAt: row.created_at,
  }));
}

/** Find deferred memories across all users (for batch job). */
export async function findAllDeferredMemories(
  pool: pg.Pool,
  limit: number,
): Promise<DeferredMemory[]> {
  const result = await pool.query(
    `SELECT id, user_id, content, audn_candidates, created_at
     FROM memories
     WHERE deferred_audn = true AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    content: row.content,
    candidates: parseCandidates(row.audn_candidates),
    createdAt: row.created_at,
  }));
}

/** Clear the deferred flag after reconciliation. */
export async function clearDeferredFlag(
  pool: pg.Pool,
  memoryId: string,
): Promise<void> {
  await pool.query(
    `UPDATE memories SET deferred_audn = false, audn_candidates = NULL
     WHERE id = $1`,
    [memoryId],
  );
}

/** Count memories pending deferred reconciliation for a user. */
export async function countDeferredMemories(
  pool: pg.Pool,
  userId: string,
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM memories
     WHERE user_id = $1 AND deferred_audn = true AND deleted_at IS NULL`,
    [userId],
  );
  return parseInt(result.rows[0].count, 10);
}

function parseCandidates(raw: unknown): DeferredCandidate[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  if (Array.isArray(raw)) return raw as DeferredCandidate[];
  return [];
}
