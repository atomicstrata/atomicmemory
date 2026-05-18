/**
 * atomicmem:// URI Resolver — deterministic addressing for memories and namespaces.
 *
 * Implements Phase 3 of the OpenViking integration design (2026-03-20).
 * Supports resolving hierarchical paths to memories, claims, and directories.
 */

import { MemoryRepository } from '../db/memory-repository.js';
import type { MemoryRow } from '../db/repository-types.js';
import { ClaimRepository } from '../db/claim-repository.js';
import type { ContextTier } from './tiered-loading.js';
import { buildTieredContent, type TieredContent } from './tiered-context.js';
import { escapeXml } from '../xml-escape.js';

export interface ResolvedURI {
  uri: string;
  type: 'memory' | 'claim' | 'directory';
  data: MemoryRow | MemoryRow[] | any;
  tier?: ContextTier;
}

/**
 * Resolver for atomicmem:// URIs.
 */
export class URIResolver {
  constructor(
    private repo: MemoryRepository,
    private claims: ClaimRepository,
  ) {}

  /**
   * Resolve a atomicmem:// URI to its underlying data.
   */
  async resolve(uri: string, userId: string, tier: ContextTier = 'L1'): Promise<ResolvedURI | null> {
    if (!uri.startsWith('atomicmem://')) return null;
    const path = uri.slice(11);

    if (path.startsWith('memory/')) {
      return this.resolveMemoryUri(uri, path, userId, tier);
    }

    if (path.startsWith('claim/')) {
      return this.resolveClaimUri(uri, path, userId, tier);
    }

    return this.resolveDirectoryUri(uri, path, userId, tier);
  }

  private async resolveMemoryUri(
    uri: string,
    path: string,
    userId: string,
    tier: ContextTier,
  ): Promise<ResolvedURI | null> {
    const memoryId = path.slice(7);
    const memory = await this.repo.getMemory(memoryId, userId);
    if (!memory) return null;
    return { uri, type: 'memory', data: memory, tier };
  }

  private async resolveClaimUri(
    uri: string,
    path: string,
    userId: string,
    tier: ContextTier,
  ): Promise<ResolvedURI | null> {
    const { claimId, asOf } = parseClaimPath(path.slice(6));
    const version = asOf
      ? await this.claims.getClaimVersionAtTime(claimId, userId, asOf)
      : await this.resolveCurrentClaimVersion(claimId, userId);
    if (!version || !version.memory_id) return null;
    const memory = await this.repo.getMemory(version.memory_id, userId);
    if (!memory) return null;
    return { uri, type: 'claim', data: memory, tier };
  }

  private async resolveDirectoryUri(
    uri: string,
    path: string,
    userId: string,
    tier: ContextTier,
  ): Promise<ResolvedURI | null> {
    const memories = await this.repo.findMemoriesByNamespace(userId, path);
    if (memories.length > 0) {
      return { uri, type: 'directory', data: memories, tier };
    }

    return null;
  }

  private async resolveCurrentClaimVersion(claimId: string, userId: string) {
    const claim = await this.claims.getClaim(claimId, userId);
    if (!claim || !claim.current_version_id) return null;
    return this.claims.getClaimVersion(claim.current_version_id, userId);
  }

  /** Format a resolved URI into context injection text. */
  format(resolved: ResolvedURI): string {
    if (resolved.type === 'directory') {
      const memories = resolved.data as MemoryRow[];
      return memories.map((m, i) => {
        const tiered = buildTieredContent(m.content, m.summary);
        const content = selectTierContent(tiered, resolved.tier);
        return `<memory index="${i + 1}" uri="${escapeXml(`${resolved.uri}/${m.id}`)}" tier="L0">\n${escapeXml(content)}\n</memory>`;
      }).join('\n');
    }

    const m = resolved.data as MemoryRow;
    const tiered = buildTieredContent(m.content, m.summary);
    const content = selectTierContent(tiered, resolved.tier);
    return `<memory uri="${escapeXml(resolved.uri)}" tier="${escapeXml(resolved.tier ?? '')}">\n${escapeXml(content)}\n</memory>`;
  }
}

function selectTierContent(tiered: TieredContent, tier?: ContextTier): string {
  if (tier === 'L0') return tiered.l0;
  if (tier === 'L1') return tiered.l1 || tiered.l2;
  return tiered.l2;
}

function parseClaimPath(path: string): { claimId: string; asOf: string | null } {
  const atIndex = path.lastIndexOf('@');
  if (atIndex === -1) {
    return { claimId: path, asOf: null };
  }

  const claimId = path.slice(0, atIndex);
  const asOf = path.slice(atIndex + 1);
  return { claimId, asOf: asOf.length > 0 ? asOf : null };
}
