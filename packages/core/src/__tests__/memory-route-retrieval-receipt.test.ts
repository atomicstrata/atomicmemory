/**
 * Search retrieval-receipt contract tests (radar C1).
 *
 * Asserts that BOTH `/search` and `/search/fast` always carry the
 * audit-grade `retrieval` receipt (embedding model identity, dimensions,
 * ranked candidate ids, trace id) and that each result memory carries
 * `version_id` + `observed_at`. Uses the same mocked-MemoryService +
 * ephemeral-router pattern as memory-route-service-forwarding so the test
 * needs no live Postgres while still exercising the real route formatter
 * and the dev-mode response-schema validator wired into createMemoryRouter.
 */

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService, RetrievalResult } from '../services/memory-service.js';
import type { SearchResult } from '../db/repository-types.js';

const OBSERVED_AT = new Date('2026-05-20T10:00:00.000Z');

function makeMemory(id: string, versionId: string | null): SearchResult {
  return {
    id,
    user_id: 'u',
    content: `memory ${id}`,
    embedding: [],
    memory_type: 'fact',
    importance: 0.5,
    source_site: 'site',
    source_url: '',
    episode_id: null,
    status: 'active',
    metadata: {},
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
    similarity: 0.9,
    score: 0.9,
    current_version_id: versionId,
  };
}

function makeResult(): RetrievalResult {
  return {
    memories: [makeMemory('mem-1', 'ver-1'), makeMemory('mem-2', null)],
    injectionText: 'ctx',
    citations: ['mem-1', 'mem-2'],
    retrievalMode: 'flat',
    budgetConstrained: false,
    retrievalReceipt: {
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingModelVersion: 'text-embedding-3-small',
      embeddingDimensions: 768,
      queryText: 'what is the plan',
      candidateIds: ['mem-1', 'mem-2'],
      traceId: 'trace-fixed-123',
    },
  };
}

describe('memory search — retrieval receipt (radar C1)', () => {
  let booted: BootedApp;
  const mockScopedSearch = vi.fn<MemoryService['scopedSearch']>();
  const service = { scopedSearch: mockScopedSearch } as unknown as MemoryService;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockScopedSearch.mockResolvedValue(makeResult());
  });

  afterAll(async () => {
    await booted.close();
  });

  it('POST /search emits the receipt and per-result version_id + observed_at', async () => {
    const body = await search(booted, '/memories/search');

    expect(body.retrieval).toEqual({
      embedding_provider: 'openai',
      embedding_model: 'text-embedding-3-small',
      embedding_model_version: 'text-embedding-3-small',
      embedding_dimensions: 768,
      query_text: 'what is the plan',
      candidate_ids: ['mem-1', 'mem-2'],
      trace_id: 'trace-fixed-123',
    });
    expect(body.memories[0]).toMatchObject({
      version_id: 'ver-1',
      observed_at: OBSERVED_AT.toISOString(),
    });
    expect(body.memories[1].version_id).toBeNull();
  });

  it('POST /search/fast emits the same receipt shape', async () => {
    const body = await search(booted, '/memories/search/fast');

    expect(body.retrieval.embedding_model).toBe('text-embedding-3-small');
    expect(body.retrieval.embedding_dimensions).toBe(768);
    expect(body.retrieval.candidate_ids).toEqual(['mem-1', 'mem-2']);
    expect(body.retrieval.trace_id).toBe('trace-fixed-123');
  });

  it('candidate_ids preserve the ranked memory ordering', async () => {
    const body = await search(booted, '/memories/search');
    expect(body.retrieval.candidate_ids).toEqual(body.memories.map((m) => m.id));
  });

  it('POST /search/fast marks the response deterministic (radar C2)', async () => {
    const body = await search(booted, '/memories/search/fast');
    expect(body.deterministic).toBe(true);
  });

  it('POST /search is not the deterministic path (radar C2)', async () => {
    const body = await search(booted, '/memories/search');
    expect(body.deterministic).toBe(false);
  });
});

interface ReceiptResponse {
  deterministic: boolean;
  retrieval: {
    embedding_provider: string;
    embedding_model: string;
    embedding_model_version: string;
    embedding_dimensions: number;
    query_text: string;
    candidate_ids: string[];
    trace_id: string;
  };
  memories: Array<{ id: string; version_id: string | null; observed_at: string }>;
}

async function search(booted: BootedApp, path: string): Promise<ReceiptResponse> {
  const response = await fetch(`${booted.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'u', query: 'what is the plan' }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<ReceiptResponse>;
}
