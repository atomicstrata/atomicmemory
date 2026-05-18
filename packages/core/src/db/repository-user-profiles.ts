/**
 * Repository for the user_profiles table (Sprint 3 v1.5 — H2).
 * One row per user, mutated in place by user-profile-builder.
 */
import type pg from 'pg';

export interface UserProfileRow {
  user_id: string;
  profile_text: string;
  source_memory_ids: string[];
  updated_at: Date;
}

export class UserProfileRepository {
  constructor(private readonly pool: pg.Pool) {}

  async getProfile(userId: string): Promise<UserProfileRow | null> {
    const result = await this.pool.query<UserProfileRow>(
      'SELECT user_id, profile_text, source_memory_ids, updated_at FROM user_profiles WHERE user_id = $1',
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async upsertProfile(
    userId: string,
    profileText: string,
    sourceMemoryIds: string[],
    expectedUpdatedAt?: Date,
  ): Promise<void> {
    if (expectedUpdatedAt) {
      await this.pool.query(
        `INSERT INTO user_profiles (user_id, profile_text, source_memory_ids, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET profile_text = EXCLUDED.profile_text,
               source_memory_ids = EXCLUDED.source_memory_ids,
               updated_at = NOW()
           WHERE user_profiles.updated_at <= $4`,
        [userId, profileText, sourceMemoryIds, expectedUpdatedAt],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO user_profiles (user_id, profile_text, source_memory_ids, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET profile_text = EXCLUDED.profile_text,
             source_memory_ids = EXCLUDED.source_memory_ids,
             updated_at = NOW()`,
      [userId, profileText, sourceMemoryIds],
    );
  }
}
