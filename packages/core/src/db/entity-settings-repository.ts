/**
 * Repository for the entity_settings table (Phase 2 entity config).
 * One row per user — stores per-entity extraction guidance and pipeline overrides.
 */
import type pg from 'pg';

export interface EntitySettingsRow {
  user_id: string;
  extraction_prompt: string | null;
  memory_kinds: string[] | null;
  decay_enabled: boolean;
  updated_at: Date;
}

export interface EntitySettingsInput {
  extraction_prompt?: string;
  memory_kinds?: string[];
  decay_enabled?: boolean;
}

export class EntitySettingsRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getForUser(userId: string): Promise<EntitySettingsRow | null> {
    const result = await this.pool.query<EntitySettingsRow>(
      'SELECT user_id, extraction_prompt, memory_kinds, decay_enabled, updated_at FROM entity_settings WHERE user_id = $1',
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM entity_settings WHERE user_id = $1',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async upsert(userId: string, input: EntitySettingsInput): Promise<void> {
    // I7 fix: use NOW() in SQL rather than server-side new Date() to avoid
    // clock skew between the application server and the database.
    const fields: string[] = ['user_id'];
    const values: unknown[] = [userId];
    const updates: string[] = ['updated_at = NOW()'];

    if (input.extraction_prompt !== undefined) {
      fields.push('extraction_prompt');
      values.push(input.extraction_prompt);
      updates.push('extraction_prompt = EXCLUDED.extraction_prompt');
    }
    if (input.memory_kinds !== undefined) {
      fields.push('memory_kinds');
      values.push(input.memory_kinds);
      updates.push('memory_kinds = EXCLUDED.memory_kinds');
    }
    if (input.decay_enabled !== undefined) {
      fields.push('decay_enabled');
      values.push(input.decay_enabled);
      updates.push('decay_enabled = EXCLUDED.decay_enabled');
    }

    const paramPlaceholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    await this.pool.query(
      `INSERT INTO entity_settings (${fields.join(', ')}, updated_at)
       VALUES (${paramPlaceholders}, NOW())
       ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
      values,
    );
  }
}
