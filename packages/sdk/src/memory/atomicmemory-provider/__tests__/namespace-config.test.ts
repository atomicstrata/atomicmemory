/**
 * @file AtomicMemory namespace config HTTP wiring
 *
 * Covers health() + updateConfig() against a mocked fetch. Verifies:
 *   - wire paths + methods
 *   - snake→camel mapping on the nested config snapshot
 *   - camel→snake mapping on updateConfig request body
 *   - minimal wire footprint (only caller-set fields forwarded)
 *   - HTTP error propagation for core's 410/400 deprecation gates
 *   - no workspace fields ever leak (scope contract parity with
 *     other user-only routes)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type {
  AtomicMemoryHandle,
  AtomicMemoryHealthStatus,
  HealthConfig,
} from '../handle';
import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';

function createHandle(): AtomicMemoryHandle {
  return new AtomicMemoryProvider({ apiUrl: API_URL }).getExtension<AtomicMemoryHandle>(
    'atomicmemory.base',
  )!;
}

function capturedCall(
  mockFetch: ReturnType<typeof vi.fn>,
): { url: string; body?: Record<string, unknown>; method?: string } {
  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body =
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  return { url, body, method: init?.method };
}

const rawHealthConfig = {
  retrieval_profile: 'balanced',
  embedding_provider: 'ollama',
  embedding_model: 'mxbai-embed-large',
  llm_provider: 'anthropic',
  llm_model: 'claude-sonnet-4-6',
  clarification_conflict_threshold: 0.8,
  max_search_results: 12,
  hybrid_search_enabled: true,
  iterative_retrieval_enabled: false,
  entity_graph_enabled: true,
  cross_encoder_enabled: false,
  agentic_retrieval_enabled: true,
  repair_loop_enabled: true,
} as const;

const expectedCamelConfig: HealthConfig = {
  retrievalProfile: 'balanced',
  embeddingProvider: 'ollama',
  embeddingModel: 'mxbai-embed-large',
  llmProvider: 'anthropic',
  llmModel: 'claude-sonnet-4-6',
  clarificationConflictThreshold: 0.8,
  maxSearchResults: 12,
  hybridSearchEnabled: true,
  iterativeRetrievalEnabled: false,
  entityGraphEnabled: true,
  crossEncoderEnabled: false,
  agenticRetrievalEnabled: true,
  repairLoopEnabled: true,
};

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

describe('atomicmemory.config.health', () => {
  it('GETs /v1/memories/health and maps the snake_case config to camelCase', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', config: rawHealthConfig }),
    );
    const handle = createHandle();
    const result: AtomicMemoryHealthStatus = await handle.config.health();

    const call = capturedCall(mockFetch);
    expect(call.method).toBeUndefined(); // GET → undefined method
    expect(call.url).toBe(`${API_URL}/v1/memories/health`);
    expect(result.status).toBe('ok');
    expect(result.config).toEqual(expectedCamelConfig);
  });

  it('covers every LLMProviderName core emits (anthropic, google-genai, groq, ollama, openai, openai-compatible, transformers)', async () => {
    const llmProviders = [
      'anthropic',
      'google-genai',
      'groq',
      'ollama',
      'openai',
      'openai-compatible',
      'transformers',
    ] as const;

    for (const llm of llmProviders) {
      mockFetch = installFetchMock();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: 'ok',
          config: { ...rawHealthConfig, llm_provider: llm },
        }),
      );
      const handle = createHandle();
      const result = await handle.config.health();
      expect(result.config.llmProvider).toBe(llm);
    }
  });
});

// ---------------------------------------------------------------------------
// updateConfig — success
// ---------------------------------------------------------------------------

describe('atomicmemory.config.updateConfig', () => {
  const successBody = {
    applied: ['similarity_threshold', 'max_search_results'],
    config: rawHealthConfig,
    note: 'Threshold updates applied in-memory for local experimentation.',
  };

  it('PUTs /v1/memories/config with camel→snake body mapping and maps the response config', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));
    const handle = createHandle();

    const result = await handle.config.updateConfig({
      similarityThreshold: 0.75,
      maxSearchResults: 25,
    });

    const call = capturedCall(mockFetch);
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${API_URL}/v1/memories/config`);
    expect(call.body).toEqual({
      similarity_threshold: 0.75,
      max_search_results: 25,
    });

    expect(result.applied).toEqual(['similarityThreshold', 'maxSearchResults']);
    expect(result.config).toEqual(expectedCamelConfig);
    expect(result.note).toBe(successBody.note);
  });

  it('omits fields not set by the caller (minimal wire footprint)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));
    const handle = createHandle();
    await handle.config.updateConfig({ clarificationConflictThreshold: 0.9 });

    const body = capturedCall(mockFetch).body!;
    expect(Object.keys(body)).toEqual(['clarification_conflict_threshold']);
  });

  it('sends an empty body when called with no updates (core still returns the full snapshot)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));
    const handle = createHandle();
    await handle.config.updateConfig({});
    expect(capturedCall(mockFetch).body).toEqual({});
  });

  it('forwards all four runtime-mutable fields when set', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));
    const handle = createHandle();
    await handle.config.updateConfig({
      similarityThreshold: 0.5,
      audnCandidateThreshold: 0.6,
      clarificationConflictThreshold: 0.7,
      maxSearchResults: 30,
    });

    expect(capturedCall(mockFetch).body).toEqual({
      similarity_threshold: 0.5,
      audn_candidate_threshold: 0.6,
      clarification_conflict_threshold: 0.7,
      max_search_results: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// updateConfig — core error paths propagate as thrown errors
// ---------------------------------------------------------------------------

describe('atomicmemory.config.updateConfig error paths', () => {
  it('propagates HTTP 410 (mutation disabled) as a thrown error', async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(
        410,
        JSON.stringify({
          error: 'PUT /v1/memories/config is deprecated for production',
          detail:
            'Set CORE_RUNTIME_CONFIG_MUTATION_ENABLED=true to enable runtime mutation in dev/test environments.',
        }),
      ),
    );

    const handle = createHandle();
    await expect(
      handle.config.updateConfig({ similarityThreshold: 0.5 }),
    ).rejects.toThrow(/410/);
  });

  it('propagates HTTP 400 (startup-only field) as a thrown error', async () => {
    // Startup-only fields aren't reachable through the ConfigUpdates
    // type — but core still 400s if they somehow arrive via a
    // non-typed bypass. Simulate by returning 400 and asserting the
    // SDK wraps it cleanly.
    mockFetch.mockResolvedValueOnce(
      errorResponse(
        400,
        JSON.stringify({
          error: 'Provider/model selection is startup-only',
          rejected: ['embedding_provider'],
        }),
      ),
    );

    const handle = createHandle();
    await expect(
      handle.config.updateConfig({ similarityThreshold: 0.5 }),
    ).rejects.toThrow(/400/);
  });
});

// ---------------------------------------------------------------------------
// Workspace contamination guard — core's health + config routes accept no
// scope fields at all, and the SDK mustn't invent them.
// ---------------------------------------------------------------------------

describe('config methods never emit workspace fields on the wire', () => {
  it('health GET carries no user_id / workspace_id / agent_id / agent_scope', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', config: rawHealthConfig }),
    );
    const handle = createHandle();
    await handle.config.health();
    const url = capturedCall(mockFetch).url;
    expect(url).toBe(`${API_URL}/v1/memories/health`);
    expect(url).not.toContain('user_id');
    expect(url).not.toContain('workspace_id');
    expect(url).not.toContain('agent_id');
    expect(url).not.toContain('agent_scope');
  });

  it('updateConfig PUT body carries no scope fields', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        applied: [],
        config: rawHealthConfig,
        note: 'x',
      }),
    );
    const handle = createHandle();
    await handle.config.updateConfig({ similarityThreshold: 0.5 });
    const body = capturedCall(mockFetch).body!;
    expect(body.user_id).toBeUndefined();
    expect(body.workspace_id).toBeUndefined();
    expect(body.agent_id).toBeUndefined();
    expect(body.agent_scope).toBeUndefined();
  });
});
