/**
 * Route-level config seam tests for createMemoryRouter.
 *
 * Verifies that read-side route config now comes from the injected adapter
 * rather than the module-level singleton for health/config responses and
 * search-limit clamping.
 */

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';
import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { config, type RuntimeConfig } from '../config.js';
import { expectMaxSearchResultsApplied } from './helpers/config-route-assertions.js';

interface MutableRouteConfig {
  retrievalProfile: string;
  embeddingProvider: 'openai';
  embeddingModel: string;
  voyageDocumentModel: string;
  voyageQueryModel: string;
  llmProvider: 'openai';
  llmModel: string;
  clarificationConflictThreshold: number;
  maxSearchResults: number;
  hybridSearchEnabled: boolean;
  iterativeRetrievalEnabled: boolean;
  entityGraphEnabled: boolean;
  crossEncoderEnabled: boolean;
  agenticRetrievalEnabled: boolean;
  repairLoopEnabled: boolean;
  runtimeConfigMutationEnabled: boolean;
}

describe('memory route config seam', () => {
  let booted: BootedApp;
  let routeConfig: MutableRouteConfig;
  const search = vi.fn();

  function routeBaseConfig(): RuntimeConfig {
    return { ...config, ...routeConfig, retrievalProfile: config.retrievalProfile };
  }

  beforeAll(async () => {
    routeConfig = {
      retrievalProfile: 'route-adapter-profile',
      embeddingProvider: 'openai',
      embeddingModel: 'adapter-embedding-model',
      voyageDocumentModel: 'voyage-4-large',
      voyageQueryModel: 'voyage-4-lite',
      llmProvider: 'openai',
      llmModel: 'adapter-llm-model',
      clarificationConflictThreshold: 0.91,
      maxSearchResults: 3,
      hybridSearchEnabled: true,
      iterativeRetrievalEnabled: false,
      entityGraphEnabled: true,
      crossEncoderEnabled: true,
      agenticRetrievalEnabled: false,
      repairLoopEnabled: true,
      runtimeConfigMutationEnabled: true,
    };

    search.mockResolvedValue({
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: 'flat',
      budgetConstrained: false,
    });

    const service = {
      scopedSearch: search,
      scopedExpand: vi.fn(),
      search: vi.fn(),
      fastSearch: vi.fn(),
      workspaceSearch: vi.fn(),
      ingest: vi.fn(),
      quickIngest: vi.fn(),
      storeVerbatim: vi.fn(),
      workspaceIngest: vi.fn(),
      expand: vi.fn(),
      expandInWorkspace: vi.fn(),
      list: vi.fn(),
      listInWorkspace: vi.fn(),
      getStats: vi.fn(),
      consolidate: vi.fn(),
      executeConsolidation: vi.fn(),
      evaluateDecay: vi.fn(),
      archiveDecayed: vi.fn(),
      checkCap: vi.fn(),
      getMutationSummary: vi.fn(),
      getRecentMutations: vi.fn(),
      getAuditTrail: vi.fn(),
      getLessons: vi.fn(),
      getLessonStats: vi.fn(),
      reportLesson: vi.fn(),
      deactivateLesson: vi.fn(),
      reconcileDeferred: vi.fn(),
      resetBySource: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    } as unknown as MemoryService;

    const configRouteAdapter = {
      base: routeBaseConfig,
      current: () => ({ ...routeConfig }),
      update: (updates: { maxSearchResults?: number }) => {
        if (updates.maxSearchResults !== undefined) {
          routeConfig.maxSearchResults = updates.maxSearchResults;
        }
        return Object.keys(updates);
      },
    };

    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service, configRouteAdapter));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    search.mockClear();
    routeConfig.maxSearchResults = 3;
  });

  afterAll(async () => {
    await booted.close();
  });

  it('serves health/config payloads from the injected adapter snapshot', async () => {
    const healthRes = await fetch(`${booted.baseUrl}/memories/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.config.retrieval_profile).toBe('route-adapter-profile');
    expect(healthBody.config.max_search_results).toBe(3);

    const putRes = await fetch(`${booted.baseUrl}/memories/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_search_results: 7 }),
    });
    await expectMaxSearchResultsApplied(putRes, 7);

    const updatedHealthRes = await fetch(`${booted.baseUrl}/memories/health`);
    const updatedHealthBody = await updatedHealthRes.json();
    expect(updatedHealthBody.config.max_search_results).toBe(7);
  });

  it('PUT /memories/config returns 400 when provider/model fields are included (startup-only)', async () => {
    const res = await fetch(`${booted.baseUrl}/memories/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedding_provider: 'openai', max_search_results: 5 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/startup-only/i);
    expect(body.rejected).toContain('embedding_provider');
  });

  it('PUT /memories/config returns 410 when runtimeConfigMutationEnabled is false', async () => {
    const originalFlag = routeConfig.runtimeConfigMutationEnabled;
    routeConfig.runtimeConfigMutationEnabled = false;
    try {
      const res = await fetch(`${booted.baseUrl}/memories/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_search_results: 99 }),
      });
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.error).toMatch(/deprecated/i);
      expect(body.detail).toMatch(/CORE_RUNTIME_CONFIG_MUTATION_ENABLED/);
    } finally {
      routeConfig.runtimeConfigMutationEnabled = originalFlag;
    }
  });

  it('clamps search limits using the injected adapter snapshot', async () => {
    await fetch(`${booted.baseUrl}/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: 'user-1',
        query: 'route seam query',
        limit: 50,
      }),
    });

    expect(search).toHaveBeenCalledWith(
      { kind: 'user', userId: 'user-1' },
      'route seam query',
      expect.objectContaining({ limit: 3 }),
    );
  });
});
