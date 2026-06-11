/**
 * Fetch-by-externalId route tests (radar get/list support).
 *
 * Asserts that `GET /v1/memories/by-external-id/:externalId?user_id=X`
 * forwards to `MemoryService.getByExternalId(userId, externalId)`, returns
 * the same MemoryRow body shape as `GET /v1/memories/:id` for a match, and
 * 404s when no row matches. Uses the same mocked-MemoryService + ephemeral
 * router pattern as `memory-route-retrieval-receipt` so no live Postgres is
 * needed while still exercising the real route + dev-mode response-schema
 * validator wired into `createMemoryRouter`. The live DB query path
 * (`findMemoryByExternalId`) is Postgres-gated and covered structurally
 * here via the mocked store contract.
 */

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';
import type { MemoryRow } from '../db/repository-types.js';

const OBSERVED_AT = new Date('2026-05-20T10:00:00.000Z');
const EXTERNAL_ID = 'radar-atom-42';

function makeMemoryRow(): MemoryRow {
  return {
    id: 'mem-1',
    user_id: 'u',
    content: 'memory mem-1',
    embedding: [],
    memory_type: 'fact',
    importance: 0.5,
    source_site: 'radar',
    source_url: '',
    episode_id: null,
    status: 'active',
    metadata: { externalId: EXTERNAL_ID },
    keywords: '',
    namespace: null,
    summary: '',
    overview: '',
    trust_score: 1,
    observed_at: OBSERVED_AT,
    created_at: OBSERVED_AT,
    last_accessed_at: OBSERVED_AT,
    access_count: 0,
    expired_at: null,
    deleted_at: null,
    network: '',
    opinion_confidence: null,
    observation_subject: null,
  };
}

describe('memory fetch-by-externalId (radar get/list support)', () => {
  let booted: BootedApp;
  const mockGetByExternalId = vi.fn<MemoryService['getByExternalId']>();
  const service = { getByExternalId: mockGetByExternalId } as unknown as MemoryService;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await booted.close();
  });

  it('returns the memory for a matching metadata.externalId', async () => {
    mockGetByExternalId.mockResolvedValue(makeMemoryRow());
    const res = await fetch(
      `${booted.baseUrl}/memories/by-external-id/${EXTERNAL_ID}?user_id=u`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryRow;
    expect(body.id).toBe('mem-1');
    expect(body.metadata.externalId).toBe(EXTERNAL_ID);
    expect(mockGetByExternalId).toHaveBeenCalledWith('u', EXTERNAL_ID);
  });

  it('404s when no memory matches the externalId', async () => {
    mockGetByExternalId.mockResolvedValue(null);
    const res = await fetch(
      `${booted.baseUrl}/memories/by-external-id/missing-id?user_id=u`,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'Memory not found' });
  });

  it('400s when user_id is absent', async () => {
    const res = await fetch(`${booted.baseUrl}/memories/by-external-id/${EXTERNAL_ID}`);
    expect(res.status).toBe(400);
    expect(mockGetByExternalId).not.toHaveBeenCalled();
  });

  it('does not collide with GET /:id (two-segment path resolves to by-external-id)', async () => {
    mockGetByExternalId.mockResolvedValue(makeMemoryRow());
    const res = await fetch(
      `${booted.baseUrl}/memories/by-external-id/${EXTERNAL_ID}?user_id=u`,
    );
    expect(res.status).toBe(200);
    expect(mockGetByExternalId).toHaveBeenCalledOnce();
  });
});
