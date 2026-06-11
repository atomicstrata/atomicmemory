/**
 * @file Route integration tests for /v1/entities.
 *
 * Each test mounts createEntityRouter on an ephemeral Express app with
 * mock deps (no real DB). Pattern matches admin.test.ts.
 */

import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { requireBearer } from '../../middleware/require-bearer.js';
import { createEntityRouter, type EntityRouterDeps } from '../entities.js';
import { closeEphemeralServer, startEphemeralServer } from './ephemeral-server.js';
import type { UserProfileRow } from '../../db/repository-user-profiles.js';
import type { EntityAttributeRow } from '../../db/repository-entity-attributes.js';

const API_KEY = 'test-entity-key';

afterEach(() => {
  vi.restoreAllMocks();
});

function makePool(queryResult: { rows: unknown[]; rowCount: number } = { rows: [], rowCount: 0 }): pg.Pool {
  return { query: vi.fn(async () => queryResult) } as unknown as pg.Pool;
}

function makeDeps(overrides: Partial<EntityRouterDeps> = {}): EntityRouterDeps {
  return {
    pool: makePool(),
    memory: {
      countMemories: vi.fn(async () => 0),
      deleteAll: vi.fn(async () => undefined),
    } as unknown as EntityRouterDeps['memory'],
    entities: null,
    userProfile: null,
    entityAttributes: null,
    entityCards: null,
    entitySettings: null,
    ...overrides,
  };
}

async function mount(deps: EntityRouterDeps): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use('/v1/entities', requireBearer(API_KEY), createEntityRouter(deps));
  return startEphemeralServer(app);
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${API_KEY}` };
}

// ---------------------------------------------------------------------------
// GET /v1/entities/:entity_type/:entity_id/profile
// ---------------------------------------------------------------------------

describe('GET /v1/entities/:entity_type/:entity_id/profile', () => {
  it('returns 401 without bearer token', async () => {
    const { baseUrl, server } = await mount(makeDeps());
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/profile`);
      expect(res.status).toBe(401);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns 400 for invalid entity_type', async () => {
    const { baseUrl, server } = await mount(makeDeps());
    try {
      const res = await fetch(`${baseUrl}/v1/entities/invalid/alice/profile`, { headers: authHeaders() });
      expect(res.status).toBe(400);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns 200 with profile: null when userProfile repo is null (feature gate off)', async () => {
    const pool = makePool({ rows: [{ max: null }], rowCount: 1 });
    const memory = {
      countMemories: vi.fn(async () => 0),
      deleteAll: vi.fn(),
    } as unknown as EntityRouterDeps['memory'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory, userProfile: null }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/profile`, { headers: authHeaders() });
      const body = (await res.json()) as { profile: null; memory_count: number };
      expect(res.status).toBe(200);
      expect(body.profile).toBeNull();
      expect(body.memory_count).toBe(0);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns 200 with full profile when all repos present and populated', async () => {
    const profileRow: UserProfileRow = {
      user_id: 'alice',
      profile_text: 'Alice is a senior PM.',
      source_memory_ids: ['m1'],
      updated_at: new Date('2026-05-20T00:00:00Z'),
    };
    const attrRow: EntityAttributeRow = {
      id: 'a1',
      user_id: 'alice',
      entity_name: 'Alice',
      attribute_key: 'role',
      attribute_value: 'Senior PM',
      value_type: 'string',
      source_memory_id: null,
      observed_at: new Date('2026-05-15T00:00:00Z'),
      created_at: new Date('2026-05-15T00:00:00Z'),
    };
    const pool = makePool({ rows: [{ max: new Date('2026-05-28T00:00:00Z') }], rowCount: 1 });
    const memory = {
      countMemories: vi.fn(async () => 5),
      deleteAll: vi.fn(),
    } as unknown as EntityRouterDeps['memory'];
    const userProfile = {
      getProfile: vi.fn(async () => profileRow),
      deleteForUser: vi.fn(),
    } as unknown as EntityRouterDeps['userProfile'];
    // C3 fix: profile now calls findByUser, not findByEntity(id, id).
    const entityAttributes = {
      findByUser: vi.fn(async () => [attrRow]),
      findByEntity: vi.fn(async () => []),
      findByAttribute: vi.fn(async () => []),
      deleteAllForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entityAttributes'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory, userProfile, entityAttributes }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/profile`, { headers: authHeaders() });
      const body = (await res.json()) as {
        entity_id: string;
        profile: { summary: string };
        memory_count: number;
        attributes: Array<{ attribute: string }>;
      };
      expect(res.status).toBe(200);
      expect(body.entity_id).toBe('alice');
      expect(body.profile?.summary).toBe('Alice is a senior PM.');
      expect(body.memory_count).toBe(5);
      expect(body.attributes).toHaveLength(1);
      expect(body.attributes[0].attribute).toBe('role');
      // C3: verify findByUser was called, not findByEntity with the same id twice
      expect(entityAttributes!.findByUser).toHaveBeenCalledWith('alice', 20);
      expect(entityAttributes!.findByEntity).not.toHaveBeenCalled();
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/entities
// ---------------------------------------------------------------------------

describe('GET /v1/entities', () => {
  it('returns paginated entity list with correct memory_count from aggregate query (N1 fix)', async () => {
    // N1 fix: memory_count must reflect actual memory count (10), not subquery row count (1).
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ user_id: 'alice', memory_count: 10, last_active: new Date('2026-05-20T00:00:00Z'), total: 1 }],
        rowCount: 1,
      }),
    } as unknown as pg.Pool;
    const memory = {
      countMemories: vi.fn(async () => 0),
      deleteAll: vi.fn(),
    } as unknown as EntityRouterDeps['memory'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities?page=1&page_size=10`, { headers: authHeaders() });
      const body = (await res.json()) as { entities: Array<{ entity_id: string }>; total: number; page: number };
      expect(res.status).toBe(200);
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0].entity_id).toBe('alice');
      expect(body.total).toBe(1);
      expect(body.page).toBe(1);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns 400 for page_size > 200', async () => {
    const { baseUrl, server } = await mount(makeDeps());
    try {
      const res = await fetch(`${baseUrl}/v1/entities?page_size=999`, { headers: authHeaders() });
      expect(res.status).toBe(400);
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/entities/:entity_type/:entity_id
// ---------------------------------------------------------------------------

describe('GET /v1/entities/:entity_type/:entity_id', () => {
  it('returns entity detail with empty arrays when repos are null', async () => {
    const pool = makePool({ rows: [{ max: null }], rowCount: 1 });
    const memory = {
      countMemories: vi.fn(async () => 3),
      deleteAll: vi.fn(),
    } as unknown as EntityRouterDeps['memory'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice`, { headers: authHeaders() });
      const body = (await res.json()) as {
        entity_id: string;
        memory_count: number;
        attributes: unknown[];
        relations: unknown[];
        recent_cards: unknown[];
      };
      expect(res.status).toBe(200);
      expect(body.entity_id).toBe('alice');
      expect(body.memory_count).toBe(3);
      expect(body.attributes).toEqual([]);
      expect(body.relations).toEqual([]);
      expect(body.recent_cards).toEqual([]);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns cards from findAllByUser — not filtered by entity_name (N3 fix)', async () => {
    const pool = makePool({ rows: [{ max: null }], rowCount: 1 });
    const memory = {
      countMemories: vi.fn(async () => 1),
      deleteAll: vi.fn(),
    } as unknown as EntityRouterDeps['memory'];
    const entityCards = {
      findByUser: vi.fn(async () => []),
      findAllByUser: vi.fn(async () => [{
        id: 'c1', userId: 'alice', conversationId: 'conv1',
        entityName: 'Bob',  // different from entity_id 'alice'
        cardText: 'Bob is the CTO.', sourceObservationIds: [],
        version: 1, updatedAt: new Date('2026-05-20T00:00:00Z'),
      }]),
      deleteAllForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entityCards'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory, entityCards }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice`, { headers: authHeaders() });
      const body = (await res.json()) as { recent_cards: Array<{ entity_name: string }> };
      expect(res.status).toBe(200);
      expect(body.recent_cards).toHaveLength(1);
      expect(body.recent_cards[0].entity_name).toBe('Bob');
      expect(entityCards!.findAllByUser).toHaveBeenCalledWith('alice', 5);
      expect(entityCards!.findByUser).not.toHaveBeenCalled();
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/entities/:entity_type/:entity_id/attributes
// ---------------------------------------------------------------------------

describe('GET /v1/entities/:entity_type/:entity_id/attributes', () => {
  it('returns empty attributes array when entityAttributes repo is null (feature gate off)', async () => {
    const { baseUrl, server } = await mount(makeDeps());
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/attributes`, { headers: authHeaders() });
      const body = (await res.json()) as { attributes: unknown[] };
      expect(res.status).toBe(200);
      expect(body.attributes).toEqual([]);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('calls findByAttribute when attribute query param is provided', async () => {
    const attrRow: EntityAttributeRow = {
      id: 'a1', user_id: 'alice', entity_name: 'Alice',
      attribute_key: 'role', attribute_value: 'PM', value_type: 'string',
      source_memory_id: null, observed_at: new Date(), created_at: new Date(),
    };
    const entityAttributes = {
      findByUser: vi.fn(async () => []),
      findByEntity: vi.fn(async () => []),
      findByAttribute: vi.fn(async () => [attrRow]),
      deleteAllForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entityAttributes'];
    const { baseUrl, server } = await mount(makeDeps({ entityAttributes }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/attributes?attribute=role`, { headers: authHeaders() });
      const body = (await res.json()) as { attributes: Array<{ attribute: string }> };
      expect(res.status).toBe(200);
      expect(body.attributes[0].attribute).toBe('role');
      expect(entityAttributes!.findByAttribute).toHaveBeenCalledWith('alice', 'role', 50);
      expect(entityAttributes!.findByEntity).not.toHaveBeenCalled();
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('calls findByUser when no attribute filter is provided', async () => {
    const attrRow: EntityAttributeRow = {
      id: 'a1', user_id: 'alice', entity_name: 'Bob',
      attribute_key: 'role', attribute_value: 'CTO', value_type: 'string',
      source_memory_id: null, observed_at: new Date(), created_at: new Date(),
    };
    const entityAttributes = {
      findByUser: vi.fn(async () => [attrRow]),
      findByEntity: vi.fn(async () => []),
      findByAttribute: vi.fn(async () => []),
      deleteAllForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entityAttributes'];
    const { baseUrl, server } = await mount(makeDeps({ entityAttributes }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/attributes`, { headers: authHeaders() });
      const body = (await res.json()) as { attributes: Array<{ attribute: string; entity: string }> };
      expect(res.status).toBe(200);
      expect(body.attributes[0].entity).toBe('Bob');  // entity_name, not the user_id
      expect(entityAttributes!.findByUser).toHaveBeenCalledWith('alice', 50);
      expect(entityAttributes!.findByEntity).not.toHaveBeenCalled();
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/entities/:entity_type/:entity_id/memories/:memory_id/history
// ---------------------------------------------------------------------------

describe('GET /v1/entities/:entity_type/:entity_id/memories/:memory_id/history', () => {
  it('returns 404 when memory has no claim version', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as pg.Pool;
    const { baseUrl, server } = await mount(makeDeps({ pool }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/memories/mem-999/history`, { headers: authHeaders() });
      expect(res.status).toBe(404);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns history entries when claim exists', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ claim_id: 'claim-1' }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            id: 'v1', claim_id: 'claim-1', user_id: 'alice',
            memory_id: 'mem-1', content: 'Alice is a PM',
            embedding: [], importance: 1, source_site: '', source_url: '',
            episode_id: null, valid_from: new Date('2026-05-01T00:00:00Z'),
            valid_to: null, superseded_by_version_id: null,
            mutation_type: 'ADD', mutation_reason: null,
            previous_version_id: null, actor_model: null,
            contradiction_confidence: null, created_at: new Date(),
          }],
          rowCount: 1,
        }),
    } as unknown as pg.Pool;
    const { baseUrl, server } = await mount(makeDeps({ pool }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/memories/mem-1/history`, { headers: authHeaders() });
      const body = (await res.json()) as { memory_id: string; history: Array<{ event: string; content: string }> };
      expect(res.status).toBe(200);
      expect(body.memory_id).toBe('mem-1');
      expect(body.history).toHaveLength(1);
      expect(body.history[0].event).toBe('ADD');
      expect(body.history[0].content).toBe('Alice is a PM');
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/entities/:entity_type/:entity_id
// ---------------------------------------------------------------------------

describe('DELETE /v1/entities/:entity_type/:entity_id', () => {
  it('captures counts before deletion and reports them accurately (C1 fix)', async () => {
    // N6 fix: mock based on SQL content, not call order, to avoid fragile
    // positional assumptions about Promise.all execution sequence.
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (typeof sql !== 'string') return { rows: [], rowCount: 0 };
        if (sql.includes('entity_attributes')) return { rows: [{ count: 41 }], rowCount: 1 };
        if (sql.includes('user_profiles')) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes('entity_cards')) return { rows: [{ count: 23 }], rowCount: 1 };
        if (sql.includes('entity_settings')) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes('entity_edges')) return { rows: [{ count: 12 }], rowCount: 12 };
        if (sql.includes('entities')) return { rows: [{ count: 5 }], rowCount: 5 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as pg.Pool;
    const memory = {
      countMemories: vi.fn(async () => 147),
      deleteAll: vi.fn(async () => undefined),
    } as unknown as EntityRouterDeps['memory'];
    const { baseUrl, server } = await mount(makeDeps({ pool, memory }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice`, { method: 'DELETE', headers: authHeaders() });
      const body = (await res.json()) as {
        deleted: {
          memories: number;
          entity_attributes: number;
          profile: number;
          entity_cards: number;
          entity_settings: number;
          entity_edges: number;
          entities: number;
        };
      };
      expect(res.status).toBe(200);
      expect(body.deleted.memories).toBe(147);
      expect(body.deleted.entity_attributes).toBe(41);
      expect(body.deleted.profile).toBe(1);
      expect(body.deleted.entity_cards).toBe(23);
      expect(body.deleted.entity_settings).toBe(1);  // C2: entity_settings is tracked
      expect(body.deleted.entity_edges).toBe(12);
      expect(body.deleted.entities).toBe(5);
      expect(memory.deleteAll).toHaveBeenCalledWith('alice');
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/entities/:entity_type/:entity_id/settings
// ---------------------------------------------------------------------------

describe('PATCH /v1/entities/:entity_type/:entity_id/settings', () => {
  it('returns 400 when body is empty — no fields to patch (N4 fix)', async () => {
    const entitySettings = {
      upsert: vi.fn(),
      getForUser: vi.fn(),
      deleteForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entitySettings'];
    const { baseUrl, server } = await mount(makeDeps({ entitySettings }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/settings`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(entitySettings!.upsert).not.toHaveBeenCalled();
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns 503 when entitySettings repo is null', async () => {
    const { baseUrl, server } = await mount(makeDeps({ entitySettings: null }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/settings`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ decay_enabled: false }),
      });
      expect(res.status).toBe(503);
    } finally {
      await closeEphemeralServer(server);
    }
  });

  it('returns formatted response, not raw DB row (I6 fix)', async () => {
    const entitySettings = {
      upsert: vi.fn(async () => undefined),
      getForUser: vi.fn(async () => ({
        user_id: 'alice',
        extraction_prompt: 'Focus on healthcare facts.',
        memory_kinds: null,
        decay_enabled: true,
        updated_at: new Date('2026-05-30T00:00:00Z'),
      })),
      deleteForUser: vi.fn(),
    } as unknown as EntityRouterDeps['entitySettings'];
    const { baseUrl, server } = await mount(makeDeps({ entitySettings }));
    try {
      const res = await fetch(`${baseUrl}/v1/entities/user/alice/settings`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ extraction_prompt: 'Focus on healthcare facts.' }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      // I6: should expose entity_id, not user_id (raw DB field)
      expect(body.entity_id).toBe('alice');
      expect(body.user_id).toBeUndefined();
      expect(body.extraction_prompt).toBe('Focus on healthcare facts.');
      expect(body.updated_at).toBe('2026-05-30T00:00:00.000Z');
    } finally {
      await closeEphemeralServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// POST /v1/entities/merge — self-merge guard (I4 fix)
// ---------------------------------------------------------------------------

describe('POST /v1/entities/merge', () => {
  it('returns 400 when source and target entity_id are the same (I4 fix)', async () => {
    const { baseUrl, server } = await mount(makeDeps());
    try {
      const res = await fetch(`${baseUrl}/v1/entities/merge`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          source: { entity_type: 'user', entity_id: 'alice' },
          target: { entity_type: 'user', entity_id: 'alice' },
        }),
      });
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/different/);
    } finally {
      await closeEphemeralServer(server);
    }
  });
});
