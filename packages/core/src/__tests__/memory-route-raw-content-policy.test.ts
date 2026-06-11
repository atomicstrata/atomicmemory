/**
 * Route-level tests for the server-side raw-content policy on
 * POST /v1/memories/ingest{,/quick}.
 *
 * Trust-boundary contract under RAW_CONTENT_POLICY=reject:
 *   - VERBATIM writes (`/ingest/quick` + `skip_extraction: true`) persist the
 *     content AS the memory, so unstamped/`raw` content is refused with 422
 *     raw_content_rejected and never reaches the service. `summary`/`redacted`
 *     pass.
 *   - EXTRACTION paths (`/ingest` full, and `/ingest/quick` without
 *     skip_extraction) persist the raw transcript only as the audit episode and
 *     store derived memories. Under `reject`, unstamped/`raw` is NOT refused —
 *     it proceeds with `redactRawInput: true`, telling the service to withhold
 *     the raw transcript from `episodes.content`. Stamped content proceeds with
 *     `redactRawInput: false`.
 *   - RAW_CONTENT_POLICY=allow never refuses and never redacts.
 *
 * Policy is read from the RuntimeConfig threaded via a custom
 * RuntimeConfigRouteAdapter (`base().rawContentPolicy`), never a global.
 */

import express from 'express';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { config, type RawContentPolicy, type RuntimeConfig } from '../config.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';

const EMPTY_INGEST = {
  episodeId: 'ep',
  factsExtracted: 0,
  memoriesStored: 0,
  memoriesUpdated: 0,
  memoriesDeleted: 0,
  memoriesSkipped: 0,
  storedMemoryIds: [],
  updatedMemoryIds: [],
  memoryIds: [],
  linksCreated: 0,
  compositesCreated: 0,
};

const ingest = vi.fn();
const quickIngest = vi.fn();
const storeVerbatim = vi.fn();

function routeServiceMock(): MemoryService {
  return {
    ingest,
    quickIngest,
    storeVerbatim,
    workspaceIngest: vi.fn(),
    scopedSearch: vi.fn(),
  } as unknown as MemoryService;
}

function adapterWithPolicy(rawContentPolicy: RawContentPolicy) {
  const base: RuntimeConfig = { ...config, rawContentPolicy };
  return { base: () => base, current: () => base, update: () => [] };
}

async function bootWithPolicy(policy: RawContentPolicy): Promise<BootedApp> {
  const app = express();
  app.use(express.json());
  app.use('/memories', createMemoryRouter(routeServiceMock(), adapterWithPolicy(policy)));
  return bindEphemeral(app);
}

function postJson(booted: BootedApp, path: string, body: unknown): Promise<Response> {
  return fetch(`${booted.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BODY = { user_id: 'u', conversation: 'hi', source_site: 's' };
const VERBATIM = { ...BODY, skip_extraction: true };

describe('reject policy — verbatim writes are fail-closed', () => {
  let booted: BootedApp;
  beforeEach(async () => {
    vi.clearAllMocks();
    storeVerbatim.mockResolvedValue(EMPTY_INGEST);
    booted = await bootWithPolicy('reject');
  });
  afterAll(async () => { await booted?.close(); });

  it('raw → 422, service untouched', async () => {
    const res = await postJson(booted, '/memories/ingest/quick', { ...VERBATIM, content_class: 'raw' });
    expect(res.status).toBe(422);
    expect((await res.json()).error_code).toBe('raw_content_rejected');
    expect(storeVerbatim).not.toHaveBeenCalled();
  });

  it('absent content_class → 422 (unstamped treated as raw)', async () => {
    const res = await postJson(booted, '/memories/ingest/quick', { ...VERBATIM });
    expect(res.status).toBe(422);
    expect(storeVerbatim).not.toHaveBeenCalled();
  });

  it('content_class: summary → proceeds to storeVerbatim', async () => {
    const res = await postJson(booted, '/memories/ingest/quick', { ...VERBATIM, content_class: 'summary' });
    expect(res.status).toBe(200);
    expect(storeVerbatim).toHaveBeenCalledTimes(1);
  });
});

describe('reject policy — extraction paths redact instead of refusing', () => {
  let booted: BootedApp;
  beforeEach(async () => {
    vi.clearAllMocks();
    ingest.mockResolvedValue(EMPTY_INGEST);
    quickIngest.mockResolvedValue(EMPTY_INGEST);
    booted = await bootWithPolicy('reject');
  });
  afterAll(async () => { await booted?.close(); });

  it('full ingest, absent content_class → 200 with redactRawInput: true', async () => {
    const res = await postJson(booted, '/memories/ingest', { ...BODY });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ redactRawInput: true }));
  });

  it('full ingest, content_class: raw → 200 with redactRawInput: true', async () => {
    const res = await postJson(booted, '/memories/ingest', { ...BODY, content_class: 'raw' });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ redactRawInput: true }));
  });

  it('full ingest, content_class: summary → 200 with redactRawInput: false', async () => {
    const res = await postJson(booted, '/memories/ingest', { ...BODY, content_class: 'summary' });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ redactRawInput: false }));
  });

  it('quick ingest (no skip_extraction), absent → 200 with redactRawInput: true', async () => {
    const res = await postJson(booted, '/memories/ingest/quick', { ...BODY });
    expect(res.status).toBe(200);
    expect(quickIngest).toHaveBeenCalledWith(expect.objectContaining({ redactRawInput: true }));
  });
});

describe('allow policy — never refuses, never redacts', () => {
  let booted: BootedApp;
  beforeEach(async () => {
    vi.clearAllMocks();
    ingest.mockResolvedValue(EMPTY_INGEST);
    storeVerbatim.mockResolvedValue(EMPTY_INGEST);
    booted = await bootWithPolicy('allow');
  });
  afterAll(async () => { await booted?.close(); });

  it('full ingest, absent content_class → 200 with redactRawInput: false', async () => {
    const res = await postJson(booted, '/memories/ingest', { ...BODY });
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ redactRawInput: false }));
  });

  it('verbatim, absent content_class → 200 (accepted under allow)', async () => {
    const res = await postJson(booted, '/memories/ingest/quick', { ...VERBATIM });
    expect(res.status).toBe(200);
    expect(storeVerbatim).toHaveBeenCalledTimes(1);
  });
});
