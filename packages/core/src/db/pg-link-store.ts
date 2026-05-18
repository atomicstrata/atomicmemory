/**
 * Postgres-backed SemanticLinkStore implementation.
 */

import type pg from 'pg';
import type { SemanticLinkStore } from './stores.js';
import {
  createLinks,
  findLinkCandidates,
  findLinkedMemoryIds,
  countLinks,
  type MemoryLink,
} from './repository-links.js';

export class PgSemanticLinkStore implements SemanticLinkStore {
  constructor(private pool: pg.Pool) {}

  async createLinks(links: MemoryLink[]) { return createLinks(this.pool, links); }
  async findLinkCandidates(userId: string, embedding: number[], threshold: number, excludeId: string, limit = 10) { return findLinkCandidates(this.pool, userId, embedding, threshold, excludeId, limit); }
  async findLinkedMemoryIds(memoryIds: string[], excludeIds: Set<string>, limit: number) { return findLinkedMemoryIds(this.pool, memoryIds, excludeIds, limit); }
  async countLinks() { return countLinks(this.pool); }
}
