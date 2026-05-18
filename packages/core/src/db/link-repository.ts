/**
 * Repository for typed cross-agent memory links.
 * Stores and queries endorsement, contradiction, elaboration, and correction
 * links between memories from different agents.
 */

import pg from 'pg';

export type LinkType = 'similarity' | 'endorsement' | 'contradiction' | 'elaboration' | 'correction';

export interface MemoryLink {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  link_type: LinkType;
  source_agent_id: string | null;
  target_agent_id: string | null;
  created_at: Date;
}

export interface StoreLinkInput {
  sourceMemoryId: string;
  targetMemoryId: string;
  linkType: LinkType;
  sourceAgentId?: string | null;
  targetAgentId?: string | null;
}

export class LinkRepository {
  constructor(private pool: pg.Pool) {}

  async storeLink(input: StoreLinkInput): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO memory_links (source_memory_id, target_memory_id, link_type, source_agent_id, target_agent_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_memory_id, target_memory_id, link_type) DO NOTHING
       RETURNING id`,
      [
        input.sourceMemoryId,
        input.targetMemoryId,
        input.linkType,
        input.sourceAgentId ?? null,
        input.targetAgentId ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  async getLinksForMemory(memoryId: string): Promise<MemoryLink[]> {
    const result = await this.pool.query(
      `SELECT * FROM memory_links
       WHERE source_memory_id = $1 OR target_memory_id = $1
       ORDER BY created_at DESC`,
      [memoryId],
    );
    return result.rows as MemoryLink[];
  }

  async getLinksForMemories(memoryIds: string[]): Promise<Map<string, MemoryLink[]>> {
    if (memoryIds.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT * FROM memory_links
       WHERE source_memory_id = ANY($1::uuid[]) OR target_memory_id = ANY($1::uuid[])
       ORDER BY created_at DESC`,
      [memoryIds],
    );

    const linksByMemory = new Map<string, MemoryLink[]>();
    for (const row of result.rows as MemoryLink[]) {
      appendLink(linksByMemory, row.source_memory_id, row);
      if (row.target_memory_id !== row.source_memory_id) {
        appendLink(linksByMemory, row.target_memory_id, row);
      }
    }
    return linksByMemory;
  }
}

function appendLink(map: Map<string, MemoryLink[]>, memoryId: string, link: MemoryLink): void {
  const existing = map.get(memoryId);
  if (existing) {
    existing.push(link);
  } else {
    map.set(memoryId, [link]);
  }
}
