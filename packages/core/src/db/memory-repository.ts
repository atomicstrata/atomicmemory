/**
 * @deprecated Phase 5 — use domain-facing store interfaces from `stores.ts` instead.
 *
 * This facade remains for two reasons:
 * 1. `getPool()` is still needed by PPR and deferred-audn (raw pool access).
 * 2. External helper modules (iterative-retrieval, agentic-retrieval, query-expansion,
 *    etc.) still type their params as MemoryRepository. Those will be migrated
 *    file-by-file to accept SearchStore/EntityStore.
 *
 * Remove this file once all consumers use stores.* and pool is exposed directly.
 */

import pg from 'pg';
import {
  countMemories,
  countNeedsClarification,
  findKeywordCandidates,
  findNearDuplicates,
  findNearDuplicatesInWorkspace,
  findTemporalNeighbors,
  findTopicCandidates,
  getEpisode,
  getMemory,
  getMemoryWithClient,
  getMemoryStats,
  listMemories,
  listMemoriesInWorkspace,
  getMemoryInWorkspace,
  searchHybridSimilar,
  searchKeywordSimilar,
  searchSimilar,
  searchSimilarInWorkspace,
} from './repository-read.js';
import type { AgentScope, CanonicalMemoryObjectLineage, StoreMemoryInput } from './repository-types.js';
import {
  backdateMemories,
  deleteAll,
  expireMemory,
  expireMemoryWithClient,
  softDeleteMemory,
  softDeleteMemoryInWorkspace,
  softDeleteMemoryWithClient,
  storeCanonicalMemoryObject,
  storeEpisode,
  storeEpisodeWithClient,
  storeMemory,
  storeMemoryWithClient,
  touchMemory,
  updateMemoryContent,
  updateMemoryContentWithClient,
  updateMemoryMetadata,
  updateOpinionConfidence,
} from './repository-write.js';
import { deleteBySource } from './repository-document-delete.js';
import {
  createLinks,
  countLinks,
  fetchMemoriesByIds,
  findLinkCandidates,
  findLinkCandidatesWithClient,
  findLinkedMemoryIds,
  type MemoryLink,
} from './repository-links.js';
import {
  listAtomicFactsForMemory,
  listForesightForMemory,
  replaceAtomicFactsForMemory,
  replaceForesightForMemory,
  searchAtomicFactsHybrid,
  storeAtomicFacts,
  storeForesight,
  type StoreAtomicFactInput,
  type StoreForesightInput,
} from './repository-representations.js';
export type {
  AgentScope,
  AtomicFactRow,
  CanonicalMemoryObjectRow,
  EpisodeRow,
  ForesightRow,
  MemoryMetadata,
  MemoryRow,
  SearchResult,
  WorkspaceContext,
} from './repository-types.js';

export class MemoryRepository {
  /**
   * Optional Phase-3 raw-content adapter, threaded through `deleteAll`
   * so the wipe path also cleans up managed-blob bytes. `null` for
   * pointer-only deployments and most tests; no fallback.
   */
  private readonly rawContentStore: import('../storage/raw-content-store.js').RawContentStore | null;

  /**
   * Phase 4a per-row dispatch registry. When supplied, the `deleteAll`
   * wipe path routes each blob to the adapter registered for its
   * `storage_provider` — historical legacy rows (e.g. `local-fs://`
   * on a Filecoin-active deployment) go to the registered legacy
   * adapter. When absent, `repository-write.deleteAll` falls back to
   * `singleStoreRegistry(rawContentStore)` (the pre-Phase-4a behavior)
   * so existing test/back-compat constructions stay working.
   */
  private readonly storeRegistry:
    import('../storage/store-registry.js').RawContentStoreRegistry | undefined;

  constructor(
    private pool: pg.Pool,
    options: {
      rawContentStore?: import('../storage/raw-content-store.js').RawContentStore | null;
      storeRegistry?: import('../storage/store-registry.js').RawContentStoreRegistry;
    } = {},
  ) {
    this.rawContentStore = options.rawContentStore ?? null;
    this.storeRegistry = options.storeRegistry;
  }

  getPool() {
    return this.pool;
  }

  async storeEpisode(input: { userId: string; content: string; sourceSite: string; sourceUrl?: string; sessionId?: string; workspaceId?: string; agentId?: string }) {
    return storeEpisode(this.pool, input);
  }

  async storeEpisodeWithClient(client: pg.PoolClient, input: { userId: string; content: string; sourceSite: string; sourceUrl?: string; sessionId?: string; workspaceId?: string; agentId?: string }) {
    return storeEpisodeWithClient(client, input);
  }

  async storeCanonicalMemoryObject(input: {
    userId: string;
    objectFamily: 'ingested_fact';
    payloadFormat?: string;
    canonicalPayload: {
      factText: string;
      factType: string;
      headline: string;
      keywords: string[];
    };
    provenance: {
      episodeId: string | null;
      sourceSite: string;
      sourceUrl: string;
    };
    observedAt?: Date;
    lineage: CanonicalMemoryObjectLineage;
  }) {
    return storeCanonicalMemoryObject(this.pool, input);
  }

  async getEpisode(id: string) {
    return getEpisode(this.pool, id);
  }

  async storeMemory(input: StoreMemoryInput) {
    return storeMemory(this.pool, input);
  }

  async storeMemoryWithClient(client: pg.PoolClient, input: StoreMemoryInput) {
    return storeMemoryWithClient(client, input);
  }

  async getMemory(id: string, userId?: string) {
    return getMemory(this.pool, id, userId, false);
  }

  async getMemoryIncludingDeleted(id: string, userId?: string) {
    return getMemory(this.pool, id, userId, true);
  }

  async getMemoryIncludingDeletedWithClient(client: pg.PoolClient, id: string, userId?: string) {
    return getMemoryWithClient(client, id, userId, true);
  }

  async listMemories(userId: string, limit: number = 20, offset: number = 0, sourceSite?: string, episodeId?: string, sessionId?: string) {
    return listMemories(this.pool, userId, limit, offset, sourceSite, episodeId, sessionId);
  }

  /** Fetch the text and timestamp for all non-deleted memories for a user's
   * conversation. memories.column is `content`, not `text` — alias to the
   * caller's expected shape.
   *
   * BEAM/AMB note: AMB encodes BEAM conversation_id INTO user_id, so each
   * ingest creates a fresh episode_id but conversation memories accumulate
   * under the same user_id. Match on user_id only so the reflect worker sees
   * ALL memories from the active conversation, not just the last ingest. */
  async findByConversation(
    userId: string,
    conversationId: string,
  ): Promise<Array<{ id: string; text: string; observedAt: Date }>> {
    void conversationId;
    const { rows } = await this.pool.query<{ id: string; content: string; observed_at: Date }>(
      `SELECT id, content, observed_at
       FROM memories
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY observed_at ASC`,
      [userId],
    );
    return rows.map(r => ({ id: r.id, text: r.content, observedAt: r.observed_at }));
  }

  async listMemoriesInWorkspace(workspaceId: string, limit: number = 20, offset: number = 0, callerAgentId?: string, sessionId?: string) {
    return listMemoriesInWorkspace(this.pool, workspaceId, limit, offset, callerAgentId, sessionId);
  }

  async getMemoryInWorkspace(id: string, workspaceId: string, callerAgentId?: string) {
    return getMemoryInWorkspace(this.pool, id, workspaceId, callerAgentId);
  }

  async softDeleteMemoryInWorkspace(id: string, workspaceId: string) {
    return softDeleteMemoryInWorkspace(this.pool, id, workspaceId);
  }

  async getMemoryStats(userId: string) {
    return getMemoryStats(this.pool, userId);
  }

  async findMemoriesByNamespace(userId: string, namespace: string, limit: number = 20) {
    const { listMemoriesByNamespace } = await import('./repository-read.js');
    return listMemoriesByNamespace(this.pool, userId, namespace, limit);
  }

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

  async findNearDuplicates(userId: string, embedding: number[], threshold: number, limit: number = 3) {
    return findNearDuplicates(this.pool, userId, embedding, threshold, limit);
  }

  async findNearDuplicatesWithClient(client: pg.PoolClient, userId: string, embedding: number[], threshold: number, limit: number = 3) {
    return findNearDuplicates(client as any, userId, embedding, threshold, limit);
  }

  async findKeywordCandidates(
    userId: string,
    keywords: string[],
    limit: number = 5,
    includeExpired: boolean = false,
  ) {
    return findKeywordCandidates(this.pool, userId, keywords, limit, includeExpired);
  }

  async findKeywordCandidatesWithClient(client: pg.PoolClient, userId: string, keywords: string[], limit: number = 5) {
    return findKeywordCandidates(client as any, userId, keywords, limit);
  }

  async findTopicCandidates(userId: string, queryEmbedding: number[], limit: number) {
    return findTopicCandidates(this.pool, userId, queryEmbedding, limit);
  }

  async updateMemoryContent(
    userId: string,
    id: string,
    content: string,
    embedding: number[],
    importance: number,
    keywords?: string,
    trustScore?: number,
  ) {
    return updateMemoryContent(this.pool, userId, id, content, embedding, importance, keywords, trustScore);
  }

  async updateMemoryContentWithClient(
    client: pg.PoolClient,
    userId: string,
    id: string,
    content: string,
    embedding: number[],
    importance: number,
    keywords?: string,
    trustScore?: number,
  ) {
    return updateMemoryContentWithClient(client, userId, id, content, embedding, importance, keywords, trustScore);
  }

  async updateMemoryMetadata(
    userId: string,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    return updateMemoryMetadata(this.pool, userId, id, metadata);
  }

  async softDeleteMemory(userId: string, id: string) {
    return softDeleteMemory(this.pool, userId, id);
  }

  async softDeleteMemoryWithClient(client: pg.PoolClient, userId: string, id: string) {
    return softDeleteMemoryWithClient(client, userId, id);
  }

  /** Mark memory as temporally expired (contradicted/superseded). Preserved for temporal queries. */
  async expireMemory(userId: string, id: string) {
    return expireMemory(this.pool, userId, id);
  }

  async expireMemoryWithClient(client: pg.PoolClient, userId: string, id: string) {
    return expireMemoryWithClient(client, userId, id);
  }

  async touchMemory(id: string) {
    return touchMemory(this.pool, id);
  }

  async countMemories(userId?: string) {
    return countMemories(this.pool, userId);
  }

  async countNeedsClarification(userId: string) {
    return countNeedsClarification(this.pool, userId);
  }

  async updateOpinionConfidence(userId: string, memoryId: string, newConfidence: number) {
    return updateOpinionConfidence(this.pool, userId, memoryId, newConfidence);
  }

  async backdateMemories(ids: string[], timestamp: Date) {
    return backdateMemories(this.pool, ids, timestamp);
  }

  async storeAtomicFacts(facts: StoreAtomicFactInput[]) {
    return storeAtomicFacts(this.pool, facts);
  }

  async storeForesight(entries: StoreForesightInput[]) {
    return storeForesight(this.pool, entries);
  }

  async replaceAtomicFactsForMemory(userId: string, parentMemoryId: string, facts: StoreAtomicFactInput[]) {
    return replaceAtomicFactsForMemory(this.pool, userId, parentMemoryId, facts);
  }

  async replaceForesightForMemory(userId: string, parentMemoryId: string, entries: StoreForesightInput[]) {
    return replaceForesightForMemory(this.pool, userId, parentMemoryId, entries);
  }

  async listAtomicFactsForMemory(userId: string, parentMemoryId: string) {
    return listAtomicFactsForMemory(this.pool, userId, parentMemoryId);
  }

  async listForesightForMemory(userId: string, parentMemoryId: string) {
    return listForesightForMemory(this.pool, userId, parentMemoryId);
  }

  async deleteBySource(userId: string, sourceSite: string) {
    return deleteBySource(this.pool, userId, sourceSite);
  }

  async deleteAll(userId?: string) {
    return deleteAll(this.pool, userId, {
      rawContentStore: this.rawContentStore,
      storeRegistry: this.storeRegistry,
    });
  }

  async createLinks(links: MemoryLink[]) {
    return createLinks(this.pool, links);
  }

  async createLinksWithClient(client: pg.PoolClient, links: MemoryLink[]) {
    return createLinks(client as any, links);
  }

  async findLinkCandidates(userId: string, embedding: number[], threshold: number, excludeId: string, limit: number = 10) {
    return findLinkCandidates(this.pool, userId, embedding, threshold, excludeId, limit);
  }

  async findLinkCandidatesWithClient(client: pg.PoolClient, userId: string, embedding: number[], threshold: number, excludeId: string, limit: number = 10) {
    return findLinkCandidatesWithClient(client, userId, embedding, threshold, excludeId, limit);
  }

  async findLinkedMemoryIds(memoryIds: string[], excludeIds: Set<string>, limit: number) {
    return findLinkedMemoryIds(this.pool, memoryIds, excludeIds, limit);
  }

  async fetchMemoriesByIds(
    userId: string,
    ids: string[],
    queryEmbedding: number[],
    referenceTime?: Date,
    includeExpired: boolean = false,
  ) {
    return fetchMemoriesByIds(this.pool, userId, ids, queryEmbedding, referenceTime, includeExpired);
  }

  async findTemporalNeighbors(
    userId: string,
    anchorTimestamps: Date[],
    queryEmbedding: number[],
    windowMinutes: number,
    excludeIds: Set<string>,
    limit: number,
    referenceTime?: Date,
  ) {
    return findTemporalNeighbors(this.pool, userId, anchorTimestamps, queryEmbedding, windowMinutes, excludeIds, limit, referenceTime);
  }

  async countLinks() {
    return countLinks(this.pool);
  }

  /**
   * Workspace-scoped vector search with agent filtering and visibility enforcement.
   */
  async searchSimilarInWorkspace(
    workspaceId: string,
    queryEmbedding: number[],
    limit: number,
    agentScope: AgentScope = 'all',
    callerAgentId?: string,
    referenceTime?: Date,
    sessionId?: string,
  ) {
    return searchSimilarInWorkspace(this.pool, workspaceId, queryEmbedding, limit, agentScope, callerAgentId, referenceTime, sessionId);
  }

  /**
   * Find near-duplicate memories within a workspace for AUDN conflict detection.
   */
  async findNearDuplicatesInWorkspace(
    workspaceId: string,
    embedding: number[],
    threshold: number,
    limit: number = 3,
    agentScope: AgentScope = 'all',
    callerAgentId?: string,
  ) {
    return findNearDuplicatesInWorkspace(this.pool, workspaceId, embedding, threshold, limit, agentScope, callerAgentId);
  }
}
