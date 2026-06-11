/**
 * @file `EntitiesClient` — SDK surface for /v1/entities.
 *
 * Thin fetch wrapper over the entity API routes. All methods default
 * `entityType` to `'user'` since that is the primary use case.
 * Server responses use snake_case; this client maps to camelCase.
 *
 * Usage:
 *   const client = new AtomicMemoryClient({ apiUrl, apiKey, userId });
 *   const profile = await client.entities.profile('alice');
 *   const attrs   = await client.entities.attributes('alice', { attribute: 'role' });
 */

import type {
  DeleteEntityResult,
  EntityDetail,
  EntityListResult,
  EntityProfile,
  EntitySettings,
  EntityType,
  GetAttributesOptions,
  ListEntitiesOptions,
  MemoryHistory,
  MergeEntitiesResult,
  PatchEntitySettingsInput,
} from './types.js';

export interface EntitiesClientConfig {
  apiUrl: string;
  apiKey: string;
  /** Optional fetch override — defaults to the Node global. */
  fetch?: typeof fetch;
}

export class EntitiesClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EntitiesClientConfig) {
    if (!config.apiUrl) throw new Error('EntitiesClient: apiUrl is required');
    if (!config.apiKey) throw new Error('EntitiesClient: apiKey is required');
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Get the synthesized profile for an entity. */
  async profile(entityId: string, entityType: EntityType = 'user'): Promise<EntityProfile> {
    const res = await this.request('GET', `/v1/entities/${entityType}/${encodeURIComponent(entityId)}/profile`);
    return mapProfile(await res.json() as Record<string, unknown>);
  }

  /** List all entities with memory counts (paginated). */
  async list(opts: ListEntitiesOptions = {}): Promise<EntityListResult> {
    const qs = buildEntityListQuery(opts);
    const res = await this.request('GET', `/v1/entities${qs}`);
    return mapList(await res.json() as Record<string, unknown>);
  }

  /** Get entity detail — attributes, relations, and recent cards. */
  async get(entityId: string, entityType: EntityType = 'user'): Promise<EntityDetail> {
    const res = await this.request('GET', `/v1/entities/${entityType}/${encodeURIComponent(entityId)}`);
    return mapDetail(await res.json() as Record<string, unknown>);
  }

  /** Cascade-delete all data for an entity. */
  async delete(entityId: string, entityType: EntityType = 'user'): Promise<DeleteEntityResult> {
    const res = await this.request('DELETE', `/v1/entities/${entityType}/${encodeURIComponent(entityId)}`);
    return mapDeleteResult(await res.json() as Record<string, unknown>);
  }

  /** Get structured attribute triples for an entity. */
  async attributes(entityId: string, opts: GetAttributesOptions = {}, entityType: EntityType = 'user') {
    const qs = buildAttributesQuery(opts);
    const res = await this.request('GET', `/v1/entities/${entityType}/${encodeURIComponent(entityId)}/attributes${qs}`);
    const body = await res.json() as { attributes: unknown[] };
    return (body.attributes ?? []).map(mapAttribute);
  }

  /** Get the mutation history of a single memory record. */
  async memoryHistory(entityId: string, memoryId: string, entityType: EntityType = 'user'): Promise<MemoryHistory> {
    const res = await this.request(
      'GET',
      `/v1/entities/${entityType}/${encodeURIComponent(entityId)}/memories/${encodeURIComponent(memoryId)}/history`,
    );
    return mapHistory(await res.json() as Record<string, unknown>);
  }

  /** Update per-entity extraction guidance and pipeline config. */
  async patchSettings(entityId: string, input: PatchEntitySettingsInput, entityType: EntityType = 'user'): Promise<EntitySettings> {
    const body: Record<string, unknown> = {};
    if (input.extractionPrompt !== undefined) body.extraction_prompt = input.extractionPrompt;
    if (input.memoryKinds !== undefined) body.memory_kinds = input.memoryKinds;
    if (input.decayEnabled !== undefined) body.decay_enabled = input.decayEnabled;
    const res = await this.request(
      'PATCH',
      `/v1/entities/${entityType}/${encodeURIComponent(entityId)}/settings`,
      { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    return mapSettings(await res.json() as Record<string, unknown>);
  }

  /** Merge a source entity into a target entity. */
  async merge(
    source: { entityId: string; entityType?: EntityType },
    target: { entityId: string; entityType?: EntityType },
  ): Promise<MergeEntitiesResult> {
    const body = {
      source: { entity_type: source.entityType ?? 'user', entity_id: source.entityId },
      target: { entity_type: target.entityType ?? 'user', entity_id: target.entityId },
    };
    const res = await this.request('POST', '/v1/entities/merge', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return mapMergeResult(await res.json() as Record<string, unknown>);
  }

  private async request(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const url = `${this.apiUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
        body: init.body,
      });
    } catch (cause) {
      throw new Error(
        `EntitiesClient: network error calling ${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    throw new Error(`EntitiesClient: ${method} ${path} failed with ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

function buildEntityListQuery(opts: ListEntitiesOptions): string {
  const p = new URLSearchParams();
  if (opts.entityType) p.set('entity_type', opts.entityType);
  if (opts.page !== undefined) p.set('page', String(opts.page));
  if (opts.pageSize !== undefined) p.set('page_size', String(opts.pageSize));
  return p.toString() ? `?${p.toString()}` : '';
}

function buildAttributesQuery(opts: GetAttributesOptions): string {
  const p = new URLSearchParams();
  if (opts.attribute) p.set('attribute', opts.attribute);
  if (opts.entity) p.set('entity', opts.entity);
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  return p.toString() ? `?${p.toString()}` : '';
}

// ---------------------------------------------------------------------------
// Wire → SDK type mappers (snake_case → camelCase)
// ---------------------------------------------------------------------------

function mapAttribute(r: unknown) {
  const a = r as Record<string, unknown>;
  return {
    entity: a.entity as string,
    attribute: a.attribute as string,
    value: a.value as string,
    type: a.type as string,
    sourceMemoryId: (a.source_memory_id as string | null) ?? null,
    observedAt: a.observed_at as string,
  };
}

function mapRelation(r: unknown) {
  const row = r as Record<string, unknown>;
  return {
    targetEntityId: row.target_entity_id as string,
    relationType: row.relation_type as string,
    confidence: row.confidence as number,
    validTo: (row.valid_to as string | null) ?? null,
  };
}

function mapCard(c: unknown) {
  const card = c as Record<string, unknown>;
  return {
    entityName: card.entity_name as string,
    cardText: card.card_text as string,
    version: card.version as number,
    updatedAt: card.updated_at as string,
  };
}

function mapProfileBody(raw: Record<string, unknown> | null): import('./types.js').EntityProfile['profile'] {
  if (!raw) return null;
  return {
    summary: raw.summary as string,
    preferences: (raw.preferences as string[]) ?? [],
    instructions: (raw.instructions as string[]) ?? [],
    openCommitments: (raw.open_commitments as string[]) ?? [],
  };
}

function mapProfile(r: Record<string, unknown>): import('./types.js').EntityProfile {
  return {
    entityType: r.entity_type as import('./types.js').EntityType,
    entityId: r.entity_id as string,
    profile: mapProfileBody(r.profile as Record<string, unknown> | null),
    attributes: ((r.attributes as unknown[]) ?? []).map(mapAttribute),
    memoryCount: r.memory_count as number,
    lastActive: (r.last_active as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
  };
}

function mapList(r: Record<string, unknown>): import('./types.js').EntityListResult {
  return {
    entities: ((r.entities as unknown[]) ?? []).map((e) => {
      const entity = e as Record<string, unknown>;
      return {
        entityType: entity.entity_type as import('./types.js').EntityType,
        entityId: entity.entity_id as string,
        memoryCount: entity.memory_count as number,
        lastActive: (entity.last_active as string | null) ?? null,
      };
    }),
    total: r.total as number,
    page: r.page as number,
    pageSize: r.page_size as number,
  };
}

function mapDetail(r: Record<string, unknown>): import('./types.js').EntityDetail {
  return {
    entityType: r.entity_type as import('./types.js').EntityType,
    entityId: r.entity_id as string,
    memoryCount: r.memory_count as number,
    attributes: ((r.attributes as unknown[]) ?? []).map(mapAttribute),
    relations: ((r.relations as unknown[]) ?? []).map(mapRelation),
    recentCards: ((r.recent_cards as unknown[]) ?? []).map(mapCard),
    updatedAt: (r.updated_at as string | null) ?? null,
  };
}

function mapDeleteResult(r: Record<string, unknown>): import('./types.js').DeleteEntityResult {
  const d = r.deleted as Record<string, number>;
  return {
    deleted: {
      memories: d.memories,
      entityAttributes: d.entity_attributes,
      profile: d.profile,
      entities: d.entities,
      entityEdges: d.entity_edges,
      entityCards: d.entity_cards,
    },
  };
}

function mapHistory(r: Record<string, unknown>): import('./types.js').MemoryHistory {
  return {
    memoryId: r.memory_id as string,
    history: ((r.history as unknown[]) ?? []).map((h) => {
      const entry = h as Record<string, unknown>;
      return {
        versionId: entry.version_id as string,
        event: entry.event as string,
        content: entry.content as string,
        timestamp: entry.timestamp as string,
        supersededBy: (entry.superseded_by as string | null) ?? null,
      };
    }),
  };
}

function mapSettings(r: Record<string, unknown>): import('./types.js').EntitySettings {
  return {
    entityId: r.entity_id as string,
    extractionPrompt: (r.extraction_prompt as string | null) ?? null,
    memoryKinds: (r.memory_kinds as string[] | null) ?? null,
    decayEnabled: r.decay_enabled as boolean,
    updatedAt: r.updated_at as string,
  };
}

function mapMergeResult(r: Record<string, unknown>): import('./types.js').MergeEntitiesResult {
  const m = r.merged as Record<string, number>;
  return {
    merged: {
      memoriesMoved: m.memories_moved,
      attributesMoved: m.attributes_moved,
      cardsMoved: m.cards_moved,
    },
    targetEntityId: r.target_entity_id as string,
  };
}
