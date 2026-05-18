/**
 * Composite staleness filtering for retrieval.
 *
 * Phase 1 policy from the composite-vs-atomic retrieval contract:
 * exclude composites from default retrieval if any covered member memory is no
 * longer active. This catches superseded members (expired), invalidated or
 * deleted members, and dangling member IDs left behind after deletes.
 */

import type { SearchResult } from '../db/repository-types.js';

interface MemoryLookup {
  getMemory(id: string, userId: string): Promise<{ id: string } | null>;
}

export interface CompositeStalenessResult {
  filtered: SearchResult[];
  removedCompositeIds: string[];
}

export async function excludeStaleComposites(
  repo: MemoryLookup,
  userId: string,
  memories: SearchResult[],
): Promise<CompositeStalenessResult> {
  const memberIds = collectCompositeMemberIds(memories);
  if (memberIds.length === 0) {
    return { filtered: memories, removedCompositeIds: [] };
  }

  const activeIds = await loadActiveMemberIds(repo, userId, memberIds);
  const removedCompositeIds: string[] = [];
  const filtered = memories.filter((memory) => {
    if (!isComposite(memory)) return true;
    if (!hasStaleMember(memory, activeIds)) return true;
    removedCompositeIds.push(memory.id);
    return false;
  });

  return { filtered, removedCompositeIds };
}

function collectCompositeMemberIds(memories: SearchResult[]): string[] {
  return [...new Set(
    memories
      .filter(isComposite)
      .flatMap((memory) => parseMemberIds(memory))
      .filter((id): id is string => typeof id === 'string'),
  )];
}

async function loadActiveMemberIds(
  repo: MemoryLookup,
  userId: string,
  memberIds: string[],
): Promise<Set<string>> {
  const rows = await Promise.all(memberIds.map((id) => repo.getMemory(id, userId)));
  return new Set(rows.filter((row): row is { id: string } => row !== null).map((row) => row.id));
}

function hasStaleMember(memory: SearchResult, activeIds: Set<string>): boolean {
  const memberIds = parseMemberIds(memory);
  if (memberIds.length === 0) return false;
  return memberIds.some((id) => !activeIds.has(id));
}

function isComposite(memory: SearchResult): boolean {
  return memory.memory_type === 'composite';
}

function parseMemberIds(memory: SearchResult): string[] {
  const candidate = memory.metadata?.memberMemoryIds;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((id): id is string => typeof id === 'string');
}
