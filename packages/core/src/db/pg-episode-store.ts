/**
 * Postgres-backed EpisodeStore implementation.
 */

import type pg from 'pg';
import type { EpisodeStore } from './stores.js';
import { getEpisode } from './repository-read.js';
import { storeEpisode } from './repository-write.js';

export class PgEpisodeStore implements EpisodeStore {
  constructor(private pool: pg.Pool) {}

  async storeEpisode(input: { userId: string; content: string; sourceSite: string; sourceUrl?: string; sessionId?: string; workspaceId?: string; agentId?: string }) {
    return storeEpisode(this.pool, input);
  }

  async getEpisode(id: string) {
    return getEpisode(this.pool, id);
  }
}
