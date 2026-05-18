/**
 * Postgres-backed SearchStore implementation.
 * Delegates to repository-read.ts (vector/hybrid/keyword search) and
 * repository-links.ts (fetchMemoriesByIds).
 */

import type pg from 'pg';
import type { AgentScope } from './repository-types.js';
import type { SearchStore } from './stores.js';
import {
  findKeywordCandidates,
  findNearDuplicates,
  findNearDuplicatesInWorkspace,
  findTemporalNeighbors,
  findTopicCandidates,
  searchHybridSimilar,
  searchKeywordSimilar,
  searchSimilar,
  searchSimilarInWorkspace,
} from './repository-read.js';
import { searchAtomicFactsHybrid } from './repository-representations.js';
import { fetchMemoriesByIds } from './repository-links.js';

export class PgSearchStore implements SearchStore {
  constructor(private pool: pg.Pool) {}

  async searchSimilar(userId: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string) {
    return searchSimilar(this.pool, userId, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }

  async searchHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string) {
    return searchHybridSimilar(this.pool, userId, queryText, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }

  async searchKeyword(userId: string, queryText: string, limit: number, sourceSite?: string, sessionId?: string) {
    return searchKeywordSimilar(this.pool, userId, queryText, limit, sourceSite, sessionId);
  }

  async searchAtomicFactsHybrid(userId: string, queryText: string, queryEmbedding: number[], limit: number, sourceSite?: string, referenceTime?: Date, sessionId?: string) {
    return searchAtomicFactsHybrid(this.pool, userId, queryText, queryEmbedding, limit, sourceSite, referenceTime, sessionId);
  }

  async findNearDuplicates(userId: string, embedding: number[], threshold: number, limit = 3) {
    return findNearDuplicates(this.pool, userId, embedding, threshold, limit);
  }

  async findKeywordCandidates(userId: string, keywords: string[], limit = 5, includeExpired = false) {
    return findKeywordCandidates(this.pool, userId, keywords, limit, includeExpired);
  }

  async findTopicCandidates(userId: string, queryEmbedding: number[], limit: number) {
    return findTopicCandidates(this.pool, userId, queryEmbedding, limit);
  }

  async findTemporalNeighbors(userId: string, anchorTimestamps: Date[], queryEmbedding: number[], windowMinutes: number, excludeIds: Set<string>, limit: number, referenceTime?: Date) {
    return findTemporalNeighbors(this.pool, userId, anchorTimestamps, queryEmbedding, windowMinutes, excludeIds, limit, referenceTime);
  }

  async fetchMemoriesByIds(userId: string, ids: string[], queryEmbedding: number[], referenceTime?: Date, includeExpired = false) {
    return fetchMemoriesByIds(this.pool, userId, ids, queryEmbedding, referenceTime, includeExpired);
  }

  async searchSimilarInWorkspace(workspaceId: string, queryEmbedding: number[], limit: number, agentScope: AgentScope = 'all', callerAgentId?: string, referenceTime?: Date, sessionId?: string) {
    return searchSimilarInWorkspace(this.pool, workspaceId, queryEmbedding, limit, agentScope, callerAgentId, referenceTime, sessionId);
  }

  async findNearDuplicatesInWorkspace(workspaceId: string, embedding: number[], threshold: number, limit = 3, agentScope: AgentScope = 'all', callerAgentId?: string) {
    return findNearDuplicatesInWorkspace(this.pool, workspaceId, embedding, threshold, limit, agentScope, callerAgentId);
  }
}
