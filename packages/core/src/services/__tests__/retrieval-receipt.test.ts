/**
 * Unit tests for the retrieval-receipt finalizer (radar C1).
 *
 * Verifies the receipt sources the embedding model identity from the
 * threaded runtime config (honoring the Voyage query-model split), that
 * version ids come from a SINGLE batched claim-store lookup (never N+1),
 * and that the trace id is reused from the search trace summary when
 * present.
 */

import { describe, it, expect, vi } from 'vitest';

import { finalizeRetrievalReceipt } from '../retrieval-receipt.js';
import type { ClaimStore } from '../../db/stores.js';
import type { MemoryServiceDeps, RetrievalResult } from '../memory-service-types.js';
import type { SearchResult } from '../../db/repository-types.js';

const OPENAI_CONFIG = {
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 768,
  voyageQueryModel: 'voyage-4-lite',
} as unknown as MemoryServiceDeps['config'];

const VOYAGE_CONFIG = {
  embeddingProvider: 'voyage',
  embeddingModel: 'unused-doc-model',
  embeddingDimensions: 1024,
  voyageQueryModel: 'voyage-4-lite',
} as unknown as MemoryServiceDeps['config'];

function memoryRow(id: string): SearchResult {
  return { id, content: id, similarity: 0.5, score: 0.5 } as unknown as SearchResult;
}

function baseResult(traceId?: string): RetrievalResult {
  return {
    memories: [memoryRow('a'), memoryRow('b')],
    injectionText: '',
    citations: [],
    retrievalMode: 'flat',
    budgetConstrained: false,
    ...(traceId
      ? { retrievalSummary: { candidateIds: ['a', 'b'], candidateCount: 2, queryText: 'q', skipRepair: false, traceId } }
      : {}),
  };
}

function claimStore(versions: Map<string, string>): {
  store: ClaimStore;
  lookup: ReturnType<typeof vi.fn>;
} {
  const lookup = vi.fn().mockResolvedValue(versions);
  return { store: { getCurrentVersionIdsByMemoryIds: lookup } as unknown as ClaimStore, lookup };
}

describe('finalizeRetrievalReceipt', () => {
  it('stamps the config embedding identity and ranked candidate ids', async () => {
    const { store } = claimStore(new Map([['a', 'ver-a']]));
    const out = await finalizeRetrievalReceipt(store, OPENAI_CONFIG, 'u', 'q', baseResult('trace-1'));

    expect(out.retrievalReceipt).toEqual({
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      embeddingModelVersion: 'text-embedding-3-small',
      embeddingDimensions: 768,
      queryText: 'q',
      candidateIds: ['a', 'b'],
      traceId: 'trace-1',
    });
  });

  it('uses the Voyage query model when the provider is voyage', async () => {
    const { store } = claimStore(new Map());
    const out = await finalizeRetrievalReceipt(store, VOYAGE_CONFIG, 'u', 'q', baseResult('trace-1'));

    expect(out.retrievalReceipt?.embeddingModel).toBe('voyage-4-lite');
    expect(out.retrievalReceipt?.embeddingModelVersion).toBe('voyage-4-lite');
    expect(out.retrievalReceipt?.embeddingDimensions).toBe(1024);
  });

  it('resolves version ids in one batched lookup and defaults missing ones to null', async () => {
    const { store, lookup } = claimStore(new Map([['a', 'ver-a']]));
    const out = await finalizeRetrievalReceipt(store, OPENAI_CONFIG, 'u', 'q', baseResult('trace-1'));

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('u', ['a', 'b']);
    expect(out.memories[0].current_version_id).toBe('ver-a');
    expect(out.memories[1].current_version_id).toBeNull();
  });

  it('mints a trace id when the result carries no trace summary', async () => {
    const { store } = claimStore(new Map());
    const out = await finalizeRetrievalReceipt(store, OPENAI_CONFIG, 'u', 'q', baseResult());

    expect(out.retrievalReceipt?.traceId).toMatch(/^trace-/);
  });
});
