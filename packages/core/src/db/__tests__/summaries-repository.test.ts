/**
 * Unit tests for SummariesRepository — uses a mock pg.Pool to assert
 * SQL shape and result mapping without a live database.
 */

import { describe, it, expect } from 'vitest';
import { SummariesRepository } from '../summaries-repository.js';
import { makeMockPool } from './mock-pool.js';

describe('SummariesRepository.appendSessionSummary', () => {
  it('inserts with the 12 expected columns and returns the id', async () => {
    const { pool, calls } = makeMockPool([[{ id: 'sess-1' }]]);
    const repo = new SummariesRepository(pool);
    const id = await repo.appendSessionSummary({
      userId: 'u1',
      sessionId: 's-001',
      conversationId: 'c-1',
      sessionIndex: 0,
      summaryText: 'kickoff: chose Postgres',
      summaryEmbedding: [0.1, 0.2, 0.3],
      topics: ['kickoff', 'postgres'],
      factCount: 12,
    });
    expect(id).toBe('sess-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO session_summaries/);
    // 12 positional params expected
    expect(calls[0].values).toHaveLength(12);
    expect(calls[0].values?.[0]).toBe('u1');
    expect(calls[0].values?.[1]).toBe('s-001');
    expect(calls[0].values?.[2]).toBe('c-1');
    expect(calls[0].values?.[6]).toEqual(['kickoff', 'postgres']);
    expect(calls[0].values?.[7]).toBe(12);
    // workspace_id and agent_id default to null
    expect(calls[0].values?.[10]).toBeNull();
    expect(calls[0].values?.[11]).toBeNull();
  });
});

describe('SummariesRepository.appendConvSummary', () => {
  it('inserts conv summary with 10 columns and returns the id', async () => {
    const { pool, calls } = makeMockPool([[{ id: 'conv-1' }]]);
    const repo = new SummariesRepository(pool);
    const id = await repo.appendConvSummary({
      userId: 'u1',
      conversationId: 'c-1',
      summaryText: 'three-week project arc',
      summaryEmbedding: [0.4, 0.5, 0.6],
      sessionCount: 7,
      factCount: 88,
    });
    expect(id).toBe('conv-1');
    expect(calls[0].text).toMatch(/INSERT INTO conv_summaries/);
    expect(calls[0].values).toHaveLength(10);
    expect(calls[0].values?.[4]).toBe(7);
    expect(calls[0].values?.[5]).toBe(88);
  });
});

describe('SummariesRepository.searchTopConvSummaries', () => {
  it('queries pgvector cosine and maps rows to ConvSummaryHit', async () => {
    const { pool, calls } = makeMockPool([[
      { id: 'c-1', conversation_id: 'conv-1', similarity: 0.83, summary_text: 'x' },
      { id: 'c-2', conversation_id: 'conv-2', similarity: 0.71, summary_text: 'y' },
    ]]);
    const repo = new SummariesRepository(pool);
    const hits = await repo.searchTopConvSummaries('u1', [0.1, 0.2], 3);
    expect(hits).toHaveLength(2);
    expect(hits[0].similarity).toBeCloseTo(0.83);
    expect(calls[0].text).toMatch(/1 - \(summary_embedding <=> \$1\)/);
    expect(calls[0].text).toMatch(/ORDER BY summary_embedding <=> \$1/);
    expect(calls[0].values?.[1]).toBe('u1');
    expect(calls[0].values?.[2]).toBe(3);
  });
});

describe('SummariesRepository.searchTopSessionSummaries', () => {
  it('returns empty without query when conversationIds is empty', async () => {
    const { pool, calls } = makeMockPool([]);
    const repo = new SummariesRepository(pool);
    const hits = await repo.searchTopSessionSummaries('u1', [], [0.1], 5);
    expect(hits).toEqual([]);
    expect(calls).toHaveLength(0); // never queried the DB
  });

  it('filters to provided conv ids and maps result rows', async () => {
    const { pool, calls } = makeMockPool([[
      { id: 'ss-1', session_id: 'sess-a', conversation_id: 'c-1',
        session_index: 2, similarity: 0.9, summary_text: 's' },
    ]]);
    const repo = new SummariesRepository(pool);
    const hits = await repo.searchTopSessionSummaries('u1', ['c-1', 'c-2'], [0.1], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('sess-a');
    expect(hits[0].sessionIndex).toBe(2);
    expect(calls[0].text).toMatch(/conversation_id = ANY\(\$3::text\[\]\)/);
    expect(calls[0].values?.[2]).toEqual(['c-1', 'c-2']);
  });
});

describe('SummariesRepository.getMemoryIdsForSessions', () => {
  it('returns empty without query when sessionIds is empty', async () => {
    const { pool, calls } = makeMockPool([]);
    const repo = new SummariesRepository(pool);
    const ids = await repo.getMemoryIdsForSessions('u1', [], 100);
    expect(ids).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('joins memories↔episodes by session_id and respects soft-delete + expired filters', async () => {
    const { pool, calls } = makeMockPool([[
      { id: 'm-1' }, { id: 'm-2' },
    ]]);
    const repo = new SummariesRepository(pool);
    const ids = await repo.getMemoryIdsForSessions('u1', ['s-a', 's-b'], 50);
    expect(ids).toEqual(['m-1', 'm-2']);
    expect(calls[0].text).toMatch(/JOIN episodes e ON m\.episode_id = e\.id/);
    expect(calls[0].text).toMatch(/e\.session_id = ANY\(\$2::text\[\]\)/);
    expect(calls[0].text).toMatch(/m\.deleted_at IS NULL/);
    expect(calls[0].text).toMatch(/m\.expired_at IS NULL/);
    expect(calls[0].values?.[2]).toBe(50);
  });
});

describe('SummariesRepository.deleteAllForUser', () => {
  it('deletes from both summary tables', async () => {
    const { pool, calls } = makeMockPool([[], []]);
    const repo = new SummariesRepository(pool);
    await repo.deleteAllForUser('u-7');
    expect(calls).toHaveLength(2);
    expect(calls[0].text).toMatch(/DELETE FROM session_summaries WHERE user_id = \$1/);
    expect(calls[1].text).toMatch(/DELETE FROM conv_summaries WHERE user_id = \$1/);
  });
});
