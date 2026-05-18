/**
 * HTTP-level tests for the two PR #18 read endpoints (review #5):
 *   - GET  /v1/memories/event-chains
 *   - POST /v1/memories/first-mentions/extract
 *
 * Covers the schema-validation 400 paths (no DB hit needed for the
 * cases that are rejected before the handler runs) and one happy-path
 * end-to-end shape assertion per endpoint. The happy-path tests seed
 * the test DB and assert the response matches the response schema.
 *
 * Mirrors the route-test pattern from `src/__tests__/route-validation.test.ts`:
 * an Express app is built with `createMemoryRouter`, a real
 * `MemoryService` (wired against a real Postgres test DB plus mocked
 * embeddings + a stub LLM `chatFn`), and `fetch` is used to drive the
 * registered routes.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock embedText so the test process never hits an embedding provider
// (CI uses a placeholder OPENAI_API_KEY). Returns a deterministic zero
// vector matching the configured embedding dimensions, mirroring the
// mock pattern in route-validation.test.ts.
vi.mock('../../services/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/embedding.js')>();
  return {
    ...actual,
    embedText: vi.fn(async () => {
      const { config: cfg } = await import('../../config.js');
      return new Array(cfg.embeddingDimensions).fill(0);
    }),
  };
});

import express from 'express';
import { pool } from '../../db/pool.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import { ClaimRepository } from '../../db/claim-repository.js';
import { EntityRepository } from '../../db/repository-entities.js';
import { TllRepository } from '../../db/repository-tll.js';
import { FirstMentionRepository } from '../../db/repository-first-mentions.js';
import { FirstMentionService } from '../../services/first-mention-service.js';
import { MemoryService } from '../../services/memory-service.js';
import { createMemoryRouter } from '../memories.js';
import { setupTestSchema, unitVector } from '../../db/__tests__/test-fixtures.js';
import {
  EventChainsResponseSchema,
  FirstMentionsExtractResponseSchema,
} from '../../schemas/responses.js';

const TEST_USER = 'event-chains-route-test-user';
const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const INVALID_UUID = 'not-a-uuid';

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const app = express();
app.use(express.json());

/**
 * Stub LLM chatFn returning a static JSON array shaped like a valid
 * first-mention extraction. Used for the happy-path test on
 * /first-mentions/extract — the schema validation cases never reach
 * the LLM call.
 */
function makeStubChatFn(json: string) {
  return vi.fn(async () => ({ text: json }));
}

beforeAll(async () => {
  await setupTestSchema(pool);

  const repo = new MemoryRepository(pool);
  const claimRepo = new ClaimRepository(pool);
  const entityRepo = new EntityRepository(pool);
  const tllRepo = new TllRepository(pool);
  const fmRepo = new FirstMentionRepository(pool);
  const stubChat = makeStubChatFn(JSON.stringify([
    { topic: 'sample topic alpha', turn_id: 1, session_id: 1, anchor_date: null },
    { topic: 'sample topic beta', turn_id: 3, session_id: 1, anchor_date: null },
  ]));
  const fmService = new FirstMentionService(fmRepo, stubChat);
  const service = new MemoryService(
    repo,
    claimRepo,
    entityRepo,
    undefined,
    undefined,
    undefined,
    undefined,
    tllRepo,
    fmService,
  );
  app.use('/memories', createMemoryRouter(service));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---------------------------------------------------------------------------
// GET /v1/memories/event-chains — schema validation
// ---------------------------------------------------------------------------

describe('GET /memories/event-chains — schema validation', () => {
  it('returns 400 when user_id is missing', async () => {
    const res = await fetch(`${baseUrl}/memories/event-chains?entity_ids=${VALID_UUID}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/user_id/i);
  });

  it('returns 400 when entity_ids is missing', async () => {
    const res = await fetch(`${baseUrl}/memories/event-chains?user_id=${TEST_USER}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/entity_ids/i);
  });

  it('returns 400 when entity_ids contains an invalid UUID', async () => {
    const res = await fetch(
      `${baseUrl}/memories/event-chains?user_id=${TEST_USER}&entity_ids=${VALID_UUID},${INVALID_UUID}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/valid UUIDs/i);
  });

  it('returns 400 when entity_ids exceeds the 100-entry cap (review #6)', async () => {
    // Build 101 distinct UUIDs to trip the anti-amplification cap.
    const ids = Array.from({ length: 101 }, (_, i) => {
      const hex = (i + 1).toString(16).padStart(12, '0');
      return `00000000-0000-0000-0000-${hex}`;
    });
    const res = await fetch(
      `${baseUrl}/memories/event-chains?user_id=${TEST_USER}&entity_ids=${ids.join(',')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/at most 100/i);
  });

  it('returns 400 when entity_ids is present but contains only empty tokens', async () => {
    const res = await fetch(
      `${baseUrl}/memories/event-chains?user_id=${TEST_USER}&entity_ids=,,,`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/non-empty/i);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/memories/event-chains — happy path
// ---------------------------------------------------------------------------

describe('GET /memories/event-chains — happy path', () => {
  it('returns the seeded chain in the EventChainsResponseSchema shape', async () => {
    const repo = new MemoryRepository(pool);
    const entityRepo = new EntityRepository(pool);
    const tllRepo = new TllRepository(pool);
    const userId = `${TEST_USER}-happy`;

    // Clean slate for this user.
    await pool.query('DELETE FROM temporal_linkage_list WHERE user_id = $1', [userId]);

    const memId = await repo.storeMemory({
      userId,
      content: 'Started using Postgres on the project.',
      embedding: unitVector(101),
      importance: 0.7,
      sourceSite: 'event-chains-test',
    });
    const entityId = await entityRepo.resolveEntity({
      userId,
      name: 'Postgres',
      entityType: 'tool',
      embedding: unitVector(102),
    });
    await tllRepo.append(userId, memId, [entityId], new Date('2026-01-15T00:00:00Z'));

    const res = await fetch(
      `${baseUrl}/memories/event-chains?user_id=${userId}&entity_ids=${entityId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = EventChainsResponseSchema.parse(body);
    expect(parsed.chains).toHaveLength(1);
    expect(parsed.chains[0].entity_id).toBe(entityId);
    expect(parsed.chains[0].events).toHaveLength(1);
    const ev = parsed.chains[0].events[0];
    expect(ev.memory_id).toBe(memId);
    expect(ev.position_in_chain).toBe(0);
    expect(ev.predecessor_memory_id).toBeNull();
    expect(typeof ev.observation_date).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/memories/first-mentions/extract — schema validation
// ---------------------------------------------------------------------------

describe('POST /memories/first-mentions/extract — schema validation', () => {
  async function postExpecting400(body: Record<string, unknown>): Promise<{ error: string }> {
    const res = await fetch(`${baseUrl}/memories/first-mentions/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    return (await res.json()) as { error: string };
  }

  it('returns 400 when user_id is missing', async () => {
    const { error } = await postExpecting400({
      conversation_text: 'hi',
      source_site: 'beam',
      memory_ids_by_turn_id: { '1': VALID_UUID },
    });
    expect(error).toMatch(/user_id/i);
  });

  it('returns 400 when conversation_text is empty', async () => {
    const { error } = await postExpecting400({
      user_id: TEST_USER,
      conversation_text: '',
      source_site: 'beam',
      memory_ids_by_turn_id: { '1': VALID_UUID },
    });
    // Zod min(1) message — match loosely on the field name.
    expect(error).toMatch(/conversation_text/i);
  });

  it('returns 400 when conversation_text exceeds the max length cap', async () => {
    // The schema cap is 100_000 characters. Build a string just over it.
    const oversized = 'x'.repeat(100_001);
    const { error } = await postExpecting400({
      user_id: TEST_USER,
      conversation_text: oversized,
      source_site: 'beam',
      memory_ids_by_turn_id: { '1': VALID_UUID },
    });
    expect(error).toMatch(/conversation_text/i);
  });

  it('returns 400 when memory_ids_by_turn_id is missing entirely', async () => {
    const { error } = await postExpecting400({
      user_id: TEST_USER,
      conversation_text: 'hi',
      source_site: 'beam',
    });
    expect(error).toMatch(/memory_ids_by_turn_id/i);
  });

  it('returns 400 when source_site is missing', async () => {
    const { error } = await postExpecting400({
      user_id: TEST_USER,
      conversation_text: 'hi',
      memory_ids_by_turn_id: { '1': VALID_UUID },
    });
    expect(error).toMatch(/source_site/i);
  });

  it('returns 400 (not 500) when a memory_ids_by_turn_id value is not a UUID', async () => {
    // Without schema-layer UUID validation, a bad value reaches Postgres
    // and crashes with "invalid input syntax for type uuid", which the
    // route handler maps to 500. The schema must reject it as 400 instead.
    const { error } = await postExpecting400({
      user_id: TEST_USER,
      conversation_text: 'hi',
      source_site: 'beam',
      memory_ids_by_turn_id: { '1': INVALID_UUID },
    });
    expect(error).toMatch(/memory_ids_by_turn_id/i);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/memories/first-mentions/extract — happy path
// ---------------------------------------------------------------------------

async function seedMemoryFor(userId: string, content: string, seed: number): Promise<string> {
  const repo = new MemoryRepository(pool);
  return repo.storeMemory({
    userId,
    content,
    embedding: unitVector(seed),
    importance: 0.6,
    sourceSite: 'first-mentions-test',
  });
}

describe('POST /memories/first-mentions/extract — happy path', () => {
  it('returns the stub-extracted events in the FirstMentionsExtractResponseSchema shape', async () => {
    const userId = `${TEST_USER}-fm-happy`;
    const mem1 = await seedMemoryFor(userId, 'turn 1 memory', 201);
    const mem3 = await seedMemoryFor(userId, 'turn 3 memory', 202);

    const res = await fetch(`${baseUrl}/memories/first-mentions/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        conversation_text: 'turn 1: started X. turn 3: switched to Y.',
        source_site: 'first-mentions-test',
        memory_ids_by_turn_id: { '1': mem1, '3': mem3 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = FirstMentionsExtractResponseSchema.parse(body);
    expect(parsed.events).toHaveLength(2);
    // Topics come from the stub chatFn; positions are post-sorted (review #7).
    expect(parsed.events.map((e) => e.topic)).toEqual([
      'sample topic alpha',
      'sample topic beta',
    ]);
    expect(parsed.events.map((e) => e.position_in_conversation)).toEqual([0, 1]);
    expect(parsed.events.map((e) => e.memory_id)).toEqual([mem1, mem3]);
  });
});
