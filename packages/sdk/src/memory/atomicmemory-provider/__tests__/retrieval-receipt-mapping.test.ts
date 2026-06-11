/**
 * @file Asserts the SDK mappers surface the retrieval-receipt fields the v1
 * contract declares: per-result `versionId`/`observedAt` on search hits, and the
 * page-level receipt mapped from the snake_case wire shape to camelCase. Earlier
 * conformance coverage validated the wire golden against the schema but bypassed
 * the mapper, so it could not catch the SDK dropping these fields.
 */

import { describe, it, expect } from 'vitest';
import { toSearchResult, toRetrievalReceipt } from '../mappers';
import type { Scope } from '../../types';

const SCOPE: Scope = { user: 'u1' };

describe('retrieval-receipt mapping', () => {
  it('toSearchResult surfaces per-result version_id and observed_at', () => {
    const r = toSearchResult(
      { id: 'm1', content: 'hi', score: 0.5, version_id: 'v7', observed_at: '2026-05-20T10:00:00.000Z' } as never,
      SCOPE,
    );
    expect(r.versionId).toBe('v7');
    expect(r.observedAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('toSearchResult passes a null version_id through (unversioned hit)', () => {
    const r = toSearchResult({ id: 'm2', content: 'hi', score: 0.1, version_id: null } as never, SCOPE);
    expect(r.versionId).toBeNull();
  });

  it('toSearchResult omits the receipt fields when the wire does not carry them', () => {
    const r = toSearchResult({ id: 'm3', content: 'hi', score: 0.1 } as never, SCOPE);
    expect('versionId' in r).toBe(false);
    expect('observedAt' in r).toBe(false);
  });

  it('toRetrievalReceipt maps the snake_case wire receipt to camelCase', () => {
    const receipt = toRetrievalReceipt({
      embedding_provider: 'voyage',
      embedding_model: 'voyage-3',
      embedding_model_version: '1',
      embedding_dimensions: 1024,
      query_text: 'q',
      candidate_ids: ['m1', 'm2'],
      trace_id: 't1',
    });
    expect(receipt).toEqual({
      embeddingProvider: 'voyage',
      embeddingModel: 'voyage-3',
      embeddingModelVersion: '1',
      embeddingDimensions: 1024,
      queryText: 'q',
      candidateIds: ['m1', 'm2'],
      traceId: 't1',
    });
  });
});
