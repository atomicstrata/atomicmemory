/**
 * Repository for the typed belief graph (TBC Phase 3).
 * Stores and queries edges produced by the EvidenceFor / Counter / Supersede /
 * Promote / Demote operators of the typed belief calculus.
 *
 * Schema lives in src/db/schema.sql under "TBC Phase 3" section.
 * Activated only when `TBC_ENABLED=true`.
 */

import pg from 'pg';

export type BeliefEdgeType =
  | 'evidence_for'
  | 'counter'
  | 'supersedes'
  | 'promotes'
  | 'demotes';

export interface BeliefEdge {
  id: string;
  user_id: string;
  source_id: string;
  target_id: string;
  edge_type: BeliefEdgeType;
  weight: number;
  rationale: string;
  created_at: Date;
  workspace_id: string | null;
  agent_id: string | null;
}

export interface AppendEdgeInput {
  userId: string;
  sourceId: string;
  targetId: string;
  edgeType: BeliefEdgeType;
  weight: number;
  rationale: string;
  workspaceId?: string | null;
  agentId?: string | null;
}

export interface ConfidenceAggregate {
  evidenceForCount: number;
  counterCount: number;
  evidenceForWeightSum: number;
  counterWeightSum: number;
  /** Net confidence delta = sum(evidence_for weights) - |sum(counter weights)|. Bounded [-1,1] by clamp. */
  netDelta: number;
}

export class BeliefEdgesRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Insert a typed edge. Returns the new row's id. */
  async appendEdge(input: AppendEdgeInput): Promise<string> {
    validateWeightForType(input.edgeType, input.weight);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO belief_edges
        (user_id, source_id, target_id, edge_type, weight, rationale, workspace_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.userId,
        input.sourceId,
        input.targetId,
        input.edgeType,
        input.weight,
        input.rationale,
        input.workspaceId ?? null,
        input.agentId ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  /** All edges pointing at a given target (for "what supports/contradicts X" queries). */
  async getEdgesForTarget(userId: string, targetId: string): Promise<BeliefEdge[]> {
    const result = await this.pool.query<BeliefEdgeRow>(
      `SELECT id, user_id, source_id, target_id, edge_type, weight, rationale,
              created_at, workspace_id, agent_id
       FROM belief_edges
       WHERE user_id = $1 AND target_id = $2
       ORDER BY created_at DESC`,
      [userId, targetId],
    );
    return result.rows.map(rowToBeliefEdge);
  }

  /** All edges originating from a given source (for "what does this evidence affect" queries). */
  async getEdgesFromSource(userId: string, sourceId: string): Promise<BeliefEdge[]> {
    const result = await this.pool.query<BeliefEdgeRow>(
      `SELECT id, user_id, source_id, target_id, edge_type, weight, rationale,
              created_at, workspace_id, agent_id
       FROM belief_edges
       WHERE user_id = $1 AND source_id = $2
       ORDER BY created_at DESC`,
      [userId, sourceId],
    );
    return result.rows.map(rowToBeliefEdge);
  }

  /**
   * Fold all evidence/counter edges pointing at a target into a single
   * confidence-delta reading. Caller decides how to apply the delta to
   * memories.confidence (e.g., max-cap at 1.0, floor at 0.0).
   */
  async aggregateConfidenceDelta(
    userId: string,
    targetId: string,
  ): Promise<ConfidenceAggregate> {
    const result = await this.pool.query<{
      edge_type: BeliefEdgeType;
      n: string;
      sum_weight: string | null;
    }>(
      `SELECT edge_type, COUNT(*)::int AS n, SUM(weight)::float AS sum_weight
       FROM belief_edges
       WHERE user_id = $1 AND target_id = $2
         AND edge_type IN ('evidence_for', 'counter')
       GROUP BY edge_type`,
      [userId, targetId],
    );
    let evidenceForCount = 0;
    let counterCount = 0;
    let evidenceForWeightSum = 0;
    let counterWeightSum = 0;
    for (const row of result.rows) {
      const sum = row.sum_weight === null ? 0 : Number(row.sum_weight);
      if (row.edge_type === 'evidence_for') {
        evidenceForCount = Number(row.n);
        evidenceForWeightSum = sum;
      } else if (row.edge_type === 'counter') {
        counterCount = Number(row.n);
        counterWeightSum = sum;
      }
    }
    const rawDelta = evidenceForWeightSum - Math.abs(counterWeightSum);
    const netDelta = Math.max(-1, Math.min(1, rawDelta));
    return {
      evidenceForCount,
      counterCount,
      evidenceForWeightSum,
      counterWeightSum,
      netDelta,
    };
  }

  /**
   * Fetch COUNTER edges where at least one side (source or target) is in the
   * given memory ID list. Used by the CR specialist to surface bilateral
   * contradictions among the top-K retrieved set.
   */
  async findCounterEdgesForMemories(
    userId: string,
    memoryIds: string[],
  ): Promise<Array<{ sourceId: string; targetId: string; rationale: string }>> {
    if (memoryIds.length === 0) return [];
    const result = await this.pool.query<{
      source_id: string;
      target_id: string;
      rationale: string;
    }>(
      `SELECT source_id, target_id, rationale
       FROM belief_edges
       WHERE user_id = $1
         AND edge_type = 'counter'
         AND (source_id = ANY($2) OR target_id = ANY($2))`,
      [userId, memoryIds],
    );
    return result.rows.map(r => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      rationale: r.rationale,
    }));
  }

  /** Test/dev helper: remove all edges for a user (e.g., between integration runs). */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM belief_edges WHERE user_id = $1`, [userId]);
  }
}

interface BeliefEdgeRow {
  id: string;
  user_id: string;
  source_id: string;
  target_id: string;
  edge_type: BeliefEdgeType;
  weight: number;
  rationale: string;
  created_at: Date;
  workspace_id: string | null;
  agent_id: string | null;
}

function rowToBeliefEdge(row: BeliefEdgeRow): BeliefEdge {
  return { ...row };
}

/** Edge weight semantics by type. Schema check enforces [-1,1]; this enforces sign. */
function validateWeightForType(edgeType: BeliefEdgeType, weight: number): void {
  if (!Number.isFinite(weight) || weight < -1 || weight > 1) {
    throw new Error(`belief_edges weight must be in [-1, 1], got ${weight}`);
  }
  if (edgeType === 'evidence_for' && weight < 0) {
    throw new Error(`evidence_for edge weight must be >= 0 (got ${weight})`);
  }
  if (edgeType === 'counter' && weight > 0) {
    throw new Error(`counter edge weight must be <= 0 (got ${weight})`);
  }
}
