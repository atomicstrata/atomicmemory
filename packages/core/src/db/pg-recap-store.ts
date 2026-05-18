/**
 * Postgres-backed RecapStore (Sprint 3 v1). Delegates to repository-recaps.
 */

import type pg from 'pg';
import type { RecapStore } from './stores.js';
import {
  findRecapCandidates,
  findUnconsolidatedClusters,
  storeRecap,
  type StoreRecapInput,
} from './repository-recaps.js';

export class PgRecapStore implements RecapStore {
  constructor(private pool: pg.Pool) {}

  async findUnconsolidatedClusters(userId: string, minSize: number, pivot: 'topic' | 'session' = 'topic') {
    return findUnconsolidatedClusters(this.pool, userId, minSize, pivot);
  }

  async storeRecap(input: StoreRecapInput) {
    return storeRecap(this.pool, input);
  }

  async findRecapCandidates(userId: string, queryEmbedding: number[], limit: number) {
    return findRecapCandidates(this.pool, userId, queryEmbedding, limit);
  }
}
