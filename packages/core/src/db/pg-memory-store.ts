/**
 * Postgres-backed MemoryStore implementation.
 * Delegates to existing repository-read.ts and repository-write.ts functions.
 */

import type pg from 'pg';
import type { MemoryStore, StoreMemoryInput } from './stores.js';
import type { CanonicalMemoryObjectLineage } from './repository-types.js';
import {
  getMemory,
  getMemoryInWorkspace,
  getMemoryStats,
  listMemories,
  listMemoriesInWorkspace,
  countMemories,
  countNeedsClarification,
} from './repository-read.js';
import {
  backdateMemories,
  deleteAll,
  expireMemory,
  softDeleteMemory,
  softDeleteMemoryInWorkspace,
  storeCanonicalMemoryObject,
  storeMemory,
  touchMemory,
  updateMemoryContent,
  updateMemoryMetadata,
  updateOpinionConfidence,
} from './repository-write.js';
import { deleteBySource } from './repository-document-delete.js';

export class PgMemoryStore implements MemoryStore {
  /**
   * Optional Phase-3 raw-content adapter, threaded through `deleteAll`
   * so the wipe path also cleans up managed-blob bytes. `null` for
   * pointer-only deployments and most tests; no fallback.
   */
  private readonly rawContentStore: import('../storage/raw-content-store.js').RawContentStore | null;

  /**
   * Phase 4a per-row dispatch registry. See `MemoryRepository` for the
   * thread-through rationale; same fallback behavior — absent registry
   * resolves to `singleStoreRegistry(rawContentStore)` inside
   * `repository-write.deleteAll`.
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

  async storeMemory(input: StoreMemoryInput) { return storeMemory(this.pool, input); }
  async getMemory(id: string, userId?: string) { return getMemory(this.pool, id, userId, false); }
  async getMemoryIncludingDeleted(id: string, userId?: string) { return getMemory(this.pool, id, userId, true); }
  async listMemories(userId: string, limit = 20, offset = 0, sourceSite?: string, episodeId?: string, sessionId?: string) { return listMemories(this.pool, userId, limit, offset, sourceSite, episodeId, sessionId); }
  async softDeleteMemory(userId: string, id: string) { return softDeleteMemory(this.pool, userId, id); }
  async updateMemoryContent(userId: string, id: string, content: string, embedding: number[], importance: number, keywords?: string, trustScore?: number) { return updateMemoryContent(this.pool, userId, id, content, embedding, importance, keywords, trustScore); }
  async updateMemoryMetadata(userId: string, id: string, metadata: Record<string, unknown>) { return updateMemoryMetadata(this.pool, userId, id, metadata); }
  async expireMemory(userId: string, id: string) { return expireMemory(this.pool, userId, id); }
  async touchMemory(id: string) { return touchMemory(this.pool, id); }
  async countMemories(userId?: string) { return countMemories(this.pool, userId); }
  async getMemoryStats(userId: string) { return getMemoryStats(this.pool, userId); }
  async deleteBySource(userId: string, sourceSite: string) { return deleteBySource(this.pool, userId, sourceSite); }
  async deleteAll(userId?: string) {
    return deleteAll(this.pool, userId, {
      rawContentStore: this.rawContentStore,
      storeRegistry: this.storeRegistry,
    });
  }
  async backdateMemories(ids: string[], timestamp: Date) { return backdateMemories(this.pool, ids, timestamp); }
  async updateOpinionConfidence(userId: string, memoryId: string, newConfidence: number) { return updateOpinionConfidence(this.pool, userId, memoryId, newConfidence); }
  async countNeedsClarification(userId: string) { return countNeedsClarification(this.pool, userId); }
  async storeCanonicalMemoryObject(input: { userId: string; objectFamily: 'ingested_fact'; payloadFormat?: string; canonicalPayload: { factText: string; factType: string; headline: string; keywords: string[] }; provenance: { episodeId: string | null; sourceSite: string; sourceUrl: string }; observedAt?: Date; lineage: CanonicalMemoryObjectLineage }) { return storeCanonicalMemoryObject(this.pool, input); }
  async getMemoryInWorkspace(id: string, workspaceId: string, callerAgentId?: string) { return getMemoryInWorkspace(this.pool, id, workspaceId, callerAgentId); }
  async listMemoriesInWorkspace(workspaceId: string, limit = 20, offset = 0, callerAgentId?: string, sessionId?: string) { return listMemoriesInWorkspace(this.pool, workspaceId, limit, offset, callerAgentId, sessionId); }
  async softDeleteMemoryInWorkspace(id: string, workspaceId: string) { return softDeleteMemoryInWorkspace(this.pool, id, workspaceId); }
}
