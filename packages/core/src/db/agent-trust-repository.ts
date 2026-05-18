/**
 * Repository for agent trust levels and memory conflict tracking.
 * Supports trust-aware AUDN conflict resolution and CLARIFY escalation.
 */

import pg from 'pg';
import { config } from '../config.js';

export interface AgentTrustRecord {
  agent_id: string;
  user_id: string;
  trust_level: number;
  display_name: string | null;
}

export interface MemoryConflict {
  id: string;
  user_id: string;
  new_memory_id: string | null;
  existing_memory_id: string | null;
  new_agent_id: string | null;
  existing_agent_id: string | null;
  new_trust_level: number | null;
  existing_trust_level: number | null;
  contradiction_confidence: number;
  clarification_note: string | null;
  status: string;
  resolution_policy: string | null;
  resolved_at: Date | null;
  created_at: Date;
  auto_resolve_after: Date | null;
}

export interface ConflictInput {
  userId: string;
  newMemoryId: string | null;
  existingMemoryId: string | null;
  newAgentId: string | null;
  existingAgentId: string | null;
  newTrustLevel: number | null;
  existingTrustLevel: number | null;
  contradictionConfidence: number;
  clarificationNote: string | null;
}

const DEFAULT_TRUST_LEVEL = 0.5;

export class AgentTrustRepository {
  constructor(private pool: pg.Pool) {}

  async getTrustLevel(agentId: string, userId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT trust_level FROM agent_trust WHERE agent_id = $1 AND user_id = $2',
      [agentId, userId],
    );
    return result.rows[0]?.trust_level ?? DEFAULT_TRUST_LEVEL;
  }

  async setTrustLevel(agentId: string, userId: string, trustLevel: number, displayName?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_trust (agent_id, user_id, trust_level, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id) DO UPDATE SET
         trust_level = EXCLUDED.trust_level,
         display_name = COALESCE(EXCLUDED.display_name, agent_trust.display_name),
         updated_at = NOW()`,
      [agentId, userId, trustLevel, displayName ?? null],
    );
  }

  async recordConflict(input: ConflictInput): Promise<string> {
    const autoResolveAfter = new Date(Date.now() + config.conflictAutoResolveMs);
    const result = await this.pool.query(
      `INSERT INTO memory_conflicts
       (user_id, new_memory_id, existing_memory_id, new_agent_id, existing_agent_id,
        new_trust_level, existing_trust_level, contradiction_confidence, clarification_note,
        auto_resolve_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.userId,
        input.newMemoryId,
        input.existingMemoryId,
        input.newAgentId,
        input.existingAgentId,
        input.newTrustLevel,
        input.existingTrustLevel,
        input.contradictionConfidence,
        input.clarificationNote,
        autoResolveAfter,
      ],
    );
    return result.rows[0].id;
  }

  async listOpenConflicts(userId: string): Promise<MemoryConflict[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_conflicts
       WHERE user_id = $1 AND status = 'open'
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows as MemoryConflict[];
  }

  async resolveConflict(
    conflictId: string,
    resolution: 'resolved_new' | 'resolved_existing' | 'resolved_both',
  ): Promise<void> {
    await this.pool.query(
      `UPDATE memory_conflicts
       SET status = $2, resolved_at = NOW(), resolution_policy = 'manual'
       WHERE id = $1`,
      [conflictId, resolution],
    );
  }

  async autoResolveExpiredConflicts(userId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE memory_conflicts
       SET status = 'auto_resolved', resolved_at = NOW(), resolution_policy = 'trust_lww'
       WHERE user_id = $1
         AND status = 'open'
         AND auto_resolve_after IS NOT NULL
         AND auto_resolve_after <= NOW()
       RETURNING id, existing_trust_level, new_trust_level, new_memory_id, existing_memory_id`,
      [userId],
    );
    return result.rowCount ?? 0;
  }
}
