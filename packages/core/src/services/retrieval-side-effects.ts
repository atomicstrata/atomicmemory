/**
 * Fire-and-forget side effects for completed searches.
 *
 * Centralizes the "after the search returns, what else happens" concerns
 * so memory-search.ts can stay focused on orchestration. Currently:
 *   - touchMemory for each returned result (updates last-accessed time)
 *   - audit event emission when auditLoggingEnabled is on
 *
 * Historically inline in memory-search.ts; extracted in Phase 7 Item 4.
 */

import type { SearchResult } from '../db/repository-types.js';
import type { MemoryServiceDeps } from './memory-service-types.js';
import { emitAuditEvent } from './audit-events.js';

/** Run post-search side effects. Swallows per-memory touch failures. */
export function recordSearchSideEffects(
  deps: MemoryServiceDeps,
  outputMemories: SearchResult[],
  userId: string,
  query: string,
  sourceSite: string | undefined,
  asOf: string | undefined,
): void {
  if (!asOf) {
    for (const memory of outputMemories) {
      deps.stores.memory.touchMemory(memory.id).catch(() => {});
    }
  }
  if (deps.config.auditLoggingEnabled) {
    emitAuditEvent('memory:retrieve', userId, {
      query: query.slice(0, 200),
      resultCount: outputMemories.length,
      topScore: outputMemories[0]?.score ?? 0,
    }, { sourceSite });
  }
}
