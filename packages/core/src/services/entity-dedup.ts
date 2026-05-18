/**
 * Shared entity deduplication utility.
 *
 * Placed in its own module to avoid extending the circular dependency between
 * extraction.ts, extraction-enrichment.ts, and event-anchor-facts.ts.
 */

import type { ExtractedEntity } from './extraction.js';

/** Deduplicate entities by type+lowered-name key. */
export function dedupeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const unique = new Map<string, ExtractedEntity>();
  for (const entity of entities) {
    unique.set(`${entity.type}:${entity.name.toLowerCase()}`, entity);
  }
  return [...unique.values()];
}
