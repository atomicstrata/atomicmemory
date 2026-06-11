/**
 * Producer-sourced golden search-response contract (radar audit #5).
 *
 * The Radar daemon hand-replicates core's `/search/fast` wire shape in Rust
 * (`crates/radar-daemon/src/memory/atomicmemory.rs`). Without a producer-owned
 * fixture, a change to core's serialization silently breaks Radar. This test
 * pins the canonical search-response object — `count`, the flat `memories[]`
 * (each with `id`/`content`/`score`/`version_id`/`observed_at`), the C1
 * `retrieval` receipt, and the `/search/fast` `deterministic: true` flag — by
 * driving the REAL route + `formatSearchResponse` over HTTP and comparing the
 * stable-key-order serialization against a committed golden fixture.
 *
 * The fixture is the single source of truth for the wire shape: the Radar side
 * vendors the SAME bytes, and the SDK S4 conformance corpus validates this same
 * golden against the v1 schemas. Regenerate intentionally with
 * `UPDATE_CONTRACT_GOLDEN=1`; any unintended drift fails this CORE test, which
 * is the point — the producer is now pinned.
 *
 * Uses the mocked-MemoryService + ephemeral-router pattern (matching
 * memory-route-retrieval-receipt) so it needs no live Postgres while still
 * exercising the real formatter and the dev-mode response-schema validator.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService, RetrievalResult } from '../services/memory-service.js';
import type { SearchResult } from '../db/repository-types.js';

/** Fixed observation/creation instant so the golden is bit-stable. */
const OBSERVED_AT = new Date('2026-05-20T10:00:00.000Z');

/** Committed golden the Radar daemon and the SDK corpus both consume. */
const GOLDEN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'radar-search-response.json',
);

/**
 * Build a deterministic core memory row. Mirrors the fixed-value pattern from
 * memory-route-retrieval-receipt so the golden reflects ACTUAL serialization.
 */
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
    session_id: null,
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

/** The canonical retrieval result the deterministic `/search/fast` path returns. */
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

describe('core search-response contract golden (radar audit #5)', () => {
  let booted: BootedApp;
  const mockScopedSearch = vi.fn<MemoryService['scopedSearch']>();
  const service = { scopedSearch: mockScopedSearch } as unknown as MemoryService;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service));
    booted = await bindEphemeral(app);
    mockScopedSearch.mockResolvedValue(makeResult());
  });

  afterAll(async () => {
    await booted.close();
  });

  it('the /search/fast response matches the committed producer golden', async () => {
    const response = await fetch(`${booted.baseUrl}/memories/search/fast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u', query: 'what is the plan' }),
    });
    expect(response.status).toBe(200);

    // Serialize with stable key order (the formatter emits keys in a fixed
    // order; JSON.stringify preserves insertion order) and a 2-space indent so
    // the golden is a readable, diff-friendly, byte-comparable artifact.
    const actual = `${JSON.stringify(await response.json(), null, 2)}\n`;

    if (process.env.UPDATE_CONTRACT_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, actual, 'utf8');
      return;
    }

    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    expect(
      actual,
      'core search-response contract changed; regenerate with UPDATE_CONTRACT_GOLDEN=1 and sync the radar copy',
    ).toBe(golden);
  });
});
