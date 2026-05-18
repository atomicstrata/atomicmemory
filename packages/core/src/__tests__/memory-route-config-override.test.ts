/**
 * Route-level integration tests for the `config_override` body field
 * on POST /memories/{search, search/fast, ingest, ingest/quick}.
 *
 * Pins four observable behaviors:
 *   1. Absent override → no `X-Atomicmem-Config-Override-*` headers
 *      (zero-cost path) and the service receives the startup config
 *      (effectiveConfig undefined).
 *   2. Present override → all three headers emitted
 *      (applied=true, hash=sha256:<hex>, keys=sorted csv).
 *   3. Search routes forward `effectiveConfig` via the scopedSearch
 *      options bag; ingest routes forward it through the named input.
 *   4. Unknown override keys do NOT 400 (the schema is permissive so
 *      new RuntimeConfig fields don't require a schema landing to be
 *      usable). They are carried through on the effective config AND
 *      surfaced via the `X-Atomicmem-Unknown-Override-Keys` response
 *      header + a server-side warning log.
 */

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { config, type RuntimeConfig } from '../config.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';

const ROUTE_CONFIG = {
  retrievalProfile: 'override-test-profile',
  embeddingProvider: 'openai' as const,
  embeddingModel: 'm',
  voyageDocumentModel: 'voyage-4-large',
  voyageQueryModel: 'voyage-4-lite',
  llmProvider: 'openai' as const,
  llmModel: 'm',
  clarificationConflictThreshold: 0.9,
  maxSearchResults: 20,
  hybridSearchEnabled: false,
  iterativeRetrievalEnabled: false,
  entityGraphEnabled: false,
  crossEncoderEnabled: false,
  agenticRetrievalEnabled: false,
  repairLoopEnabled: false,
  runtimeConfigMutationEnabled: true,
};

function routeBaseConfig(): RuntimeConfig {
  return { ...config, ...ROUTE_CONFIG, retrievalProfile: config.retrievalProfile };
}

describe('POST /memories/* — per-request config_override', () => {
  let booted: BootedApp;
  const scopedSearch = vi.fn();
  const ingest = vi.fn();
  const quickIngest = vi.fn();

  /** POST a JSON body to a route on the booted ephemeral app. */
  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`${booted.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    scopedSearch.mockResolvedValue({
      memories: [], injectionText: '', citations: [], retrievalMode: 'flat', budgetConstrained: false,
    });
    ingest.mockResolvedValue({
      episodeId: 'ep', factsExtracted: 0, memoriesStored: 0, memoriesUpdated: 0,
      memoriesDeleted: 0, memoriesSkipped: 0, storedMemoryIds: [], updatedMemoryIds: [],
      memoryIds: [], linksCreated: 0, compositesCreated: 0,
    });
    quickIngest.mockResolvedValue({
      episodeId: 'ep', factsExtracted: 0, memoriesStored: 0, memoriesUpdated: 0,
      memoriesDeleted: 0, memoriesSkipped: 0, storedMemoryIds: [], updatedMemoryIds: [],
      memoryIds: [], linksCreated: 0, compositesCreated: 0,
    });

    const service = createRouteService(scopedSearch, ingest, quickIngest);
    const adapter = {
      base: routeBaseConfig,
      current: () => ({ ...ROUTE_CONFIG }),
      update: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service, adapter));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    scopedSearch.mockClear();
    ingest.mockClear();
    quickIngest.mockClear();
  });

  afterAll(async () => { await booted.close(); });

  it('POST /search with no override → no headers, effectiveConfig undefined', async () => {
    const res = await postJson(`/memories/search`, { user_id: 'u', query: 'q' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBeNull();
    expect(res.headers.get('X-Atomicmem-Effective-Config-Hash')).toBeNull();
    expect(res.headers.get('X-Atomicmem-Config-Override-Keys')).toBeNull();
    expect(scopedSearch).toHaveBeenCalledWith(
      expect.anything(), 'q',
      expect.objectContaining({ effectiveConfig: undefined }),
    );
  });

  it('POST /search with override → three headers + effectiveConfig threaded', async () => {
    const res = await postJson(`/memories/search`, {
        user_id: 'u', query: 'q',
        config_override: { hybridSearchEnabled: true, mmrLambda: 0.8 },
      });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBe('true');
    expect(res.headers.get('X-Atomicmem-Effective-Config-Hash')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.headers.get('X-Atomicmem-Config-Override-Keys')).toBe('hybridSearchEnabled,mmrLambda');
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as { effectiveConfig: { hybridSearchEnabled: boolean; mmrLambda: number } };
    expect(options.effectiveConfig.hybridSearchEnabled).toBe(true);
    expect(options.effectiveConfig.mmrLambda).toBe(0.8);
  });

  it('POST /search with override → overlays the injected runtime config', async () => {
    const res = await postJson(`/memories/search`, {
        user_id: 'u', query: 'q',
        config_override: { hybridSearchEnabled: true },
      });
    expect(res.status).toBe(200);
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as {
      effectiveConfig: { embeddingModel: string; maxSearchResults: number; hybridSearchEnabled: boolean };
    };
    expect(options.effectiveConfig.embeddingModel).toBe('m');
    expect(options.effectiveConfig.maxSearchResults).toBe(20);
    expect(options.effectiveConfig.hybridSearchEnabled).toBe(true);
  });

  it('POST /search with threshold → forwards relevanceThreshold', async () => {
    const res = await postJson(`/memories/search`, {
      user_id: 'u',
      query: 'q',
      threshold: 0.42,
    });
    expect(res.status).toBe(200);
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as { retrievalOptions: { relevanceThreshold: number } };
    expect(options.retrievalOptions.relevanceThreshold).toBe(0.42);
  });

  it('POST /search rejects invalid threshold', async () => {
    const res = await postJson(`/memories/search`, {
      user_id: 'u',
      query: 'q',
      threshold: 1.2,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/threshold must be between 0 and 1/);
    expect(scopedSearch).not.toHaveBeenCalled();
  });

  it('POST /search/fast with override → headers and fast:true both set', async () => {
    const res = await postJson(`/memories/search/fast`, {
        user_id: 'u', query: 'q',
        config_override: { crossEncoderEnabled: true },
      });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBe('true');
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as { fast: boolean; effectiveConfig: { crossEncoderEnabled: boolean } };
    expect(options.fast).toBe(true);
    expect(options.effectiveConfig.crossEncoderEnabled).toBe(true);
  });

  it('POST /search/fast with threshold → forwards relevanceThreshold', async () => {
    const res = await postJson(`/memories/search/fast`, {
      user_id: 'u',
      query: 'q',
      threshold: 0.7,
    });
    expect(res.status).toBe(200);
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as {
      fast: boolean;
      retrievalOptions: { relevanceThreshold: number };
    };
    expect(options.fast).toBe(true);
    expect(options.retrievalOptions.relevanceThreshold).toBe(0.7);
  });

  it('POST /ingest with override → headers + named effectiveConfig input', async () => {
    ingest.mockResolvedValueOnce({
      episodeId: 'ep', factsExtracted: 0, memoriesStored: 0, memoriesUpdated: 0,
      memoriesDeleted: 0, memoriesSkipped: 0, storedMemoryIds: [], updatedMemoryIds: [],
      memoryIds: [], linksCreated: 0, compositesCreated: 0, ingestTraceId: 'ingest-trace-1',
    });
    const res = await postJson(`/memories/ingest`, {
        user_id: 'u', conversation: 'hi', source_site: 's',
        config_override: { chunkedExtractionEnabled: true, ingestTraceEnabled: true },
      });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBe('true');
    expect(res.headers.get('X-Atomicmem-Config-Override-Keys')).toBe('chunkedExtractionEnabled,ingestTraceEnabled');
    expect((await res.clone().json()).ingest_trace_id).toBe('ingest-trace-1');
    const call = ingest.mock.calls[0]!;
    const input = call[0] as { effectiveConfig: { chunkedExtractionEnabled: boolean; ingestTraceEnabled: boolean } };
    const effectiveConfig = input.effectiveConfig;
    expect(effectiveConfig.chunkedExtractionEnabled).toBe(true);
    expect(effectiveConfig.ingestTraceEnabled).toBe(true);
  });

  it('POST /ingest/quick with override → headers + named effectiveConfig input', async () => {
    const res = await postJson(`/memories/ingest/quick`, {
        user_id: 'u', conversation: 'hi', source_site: 's',
        config_override: { entropyGateEnabled: false, fastAudnEnabled: true },
      });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Keys')).toBe('entropyGateEnabled,fastAudnEnabled');
    const call = quickIngest.mock.calls[0]!;
    const input = call[0] as { effectiveConfig: { entropyGateEnabled: boolean; fastAudnEnabled: boolean } };
    const effectiveConfig = input.effectiveConfig;
    expect(effectiveConfig.entropyGateEnabled).toBe(false);
    expect(effectiveConfig.fastAudnEnabled).toBe(true);
  });

  it('unknown override key → 200, service invoked, warning header set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await postSearchWithConfigOverride(booted, { bogusFlag: true, alsoBogus: 'nope' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBe('true');
    expect(res.headers.get('X-Atomicmem-Unknown-Override-Keys')).toBe('alsoBogus,bogusFlag');
    expect(warnSpy).toHaveBeenCalled();
    expect(scopedSearch).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('mix of known and unknown keys → only unknown ones in warning header', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await postSearchWithConfigOverride(booted, { hybridSearchEnabled: true, futureFieldX: 42 });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Keys')).toBe('futureFieldX,hybridSearchEnabled');
    expect(res.headers.get('X-Atomicmem-Unknown-Override-Keys')).toBe('futureFieldX');
    warnSpy.mockRestore();
  });

  it('all-known keys → no X-Atomicmem-Unknown-Override-Keys header', async () => {
    const res = await postSearchWithConfigOverride(booted, { hybridSearchEnabled: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBe('true');
    expect(res.headers.get('X-Atomicmem-Unknown-Override-Keys')).toBeNull();
  });

  it('override raises maxSearchResults → request limit clamped to override, not startup cap', async () => {
    // Startup cap is 20 (ROUTE_CONFIG.maxSearchResults). Override raises to 50,
    // request asks for 40 — must reach the service as 40, not clamped to 20.
    const res = await postJson(`/memories/search`, {
        user_id: 'u', query: 'q', limit: 40,
        config_override: { maxSearchResults: 50 },
      });
    expect(res.status).toBe(200);
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as { limit?: number };
    expect(options.limit).toBe(40);
  });

  it('empty override object → treated as no override (no headers)', async () => {
    const res = await postJson(`/memories/search`, { user_id: 'u', query: 'q', config_override: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Atomicmem-Config-Override-Applied')).toBeNull();
    const call = scopedSearch.mock.calls[0]!;
    const options = call[2] as { effectiveConfig: unknown };
    expect(options.effectiveConfig).toBeUndefined();
  });
});

function createRouteService(
  scopedSearch: ReturnType<typeof vi.fn>,
  ingest: ReturnType<typeof vi.fn>,
  quickIngest: ReturnType<typeof vi.fn>,
): MemoryService {
  return {
    scopedSearch,
    ingest,
    quickIngest,
    storeVerbatim: vi.fn(),
    workspaceIngest: vi.fn(),
  } as unknown as MemoryService;
}

function postSearchWithConfigOverride(
  booted: BootedApp,
  configOverride: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${booted.baseUrl}/memories/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'u', query: 'q', config_override: configOverride }),
  });
}
