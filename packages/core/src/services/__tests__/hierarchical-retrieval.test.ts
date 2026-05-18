/**
 * Unit tests for the hierarchical retrieval 5th arm. Mocks SummariesRepository
 * to assert three-stage ordering, flag-off short-circuit, and empty-data paths.
 */

import { describe, it, expect, vi } from 'vitest';
import { runHierarchicalArm, type HierarchicalArmDeps } from '../hierarchical-retrieval.js';
import type { SummariesRepository } from '../../db/summaries-repository.js';

function makeMockRepo(opts: {
  convHits?: Array<{ id: string; conversationId: string; similarity: number; summaryText: string }>;
  sessionHits?: Array<{ id: string; sessionId: string; conversationId: string; sessionIndex: number; similarity: number; summaryText: string }>;
  memoryIds?: string[];
}): { repo: SummariesRepository; calls: { stage1: number; stage2: number; stage3: number } } {
  const calls = { stage1: 0, stage2: 0, stage3: 0 };
  const repo = {
    searchTopConvSummaries: vi.fn(async () => {
      calls.stage1 += 1;
      return opts.convHits ?? [];
    }),
    searchTopSessionSummaries: vi.fn(async () => {
      calls.stage2 += 1;
      return opts.sessionHits ?? [];
    }),
    getMemoryIdsForSessions: vi.fn(async () => {
      calls.stage3 += 1;
      return opts.memoryIds ?? [];
    }),
  } as unknown as SummariesRepository;
  return { repo, calls };
}

function makeDeps(enabled: boolean, repo: SummariesRepository): HierarchicalArmDeps {
  return { config: { hierarchicalRetrievalEnabled: enabled }, summariesRepo: repo };
}

describe('runHierarchicalArm — flag gating', () => {
  it('returns empty result without touching the repo when flag is off', async () => {
    const { repo, calls } = makeMockRepo({});
    const deps = makeDeps(false, repo);
    const result = await runHierarchicalArm(deps, 'u', [0.1, 0.2], {});
    expect(result.memoryIds).toEqual([]);
    expect(result.matchedConvs).toEqual([]);
    expect(result.matchedSessions).toEqual([]);
    expect(result.cost).toBe(0);
    expect(calls.stage1).toBe(0);
    expect(calls.stage2).toBe(0);
    expect(calls.stage3).toBe(0);
  });
});

describe('runHierarchicalArm — three-stage pipeline', () => {
  it('runs stage 1 → stage 2 → stage 3 in order with the right inputs', async () => {
    const convHits = [
      { id: 'c-1', conversationId: 'conv-A', similarity: 0.9, summaryText: '' },
      { id: 'c-2', conversationId: 'conv-B', similarity: 0.85, summaryText: '' },
    ];
    const sessionHits = [
      { id: 's-1', sessionId: 'sess-1', conversationId: 'conv-A',
        sessionIndex: 0, similarity: 0.92, summaryText: '' },
      { id: 's-2', sessionId: 'sess-2', conversationId: 'conv-A',
        sessionIndex: 1, similarity: 0.88, summaryText: '' },
    ];
    const memoryIds = ['m1', 'm2', 'm3'];
    const { repo, calls } = makeMockRepo({ convHits, sessionHits, memoryIds });
    const deps = makeDeps(true, repo);

    const result = await runHierarchicalArm(deps, 'u', [0.1, 0.2], {});

    expect(calls.stage1).toBe(1);
    expect(calls.stage2).toBe(1);
    expect(calls.stage3).toBe(1);
    expect(result.matchedConvs).toEqual(['conv-A', 'conv-B']);
    expect(result.matchedSessions).toEqual(['sess-1', 'sess-2']);
    expect(result.memoryIds).toEqual(['m1', 'm2', 'm3']);
    expect(result.cost).toBe(0);
  });

  it('passes default (3, 10, 50) topK values when opts omitted', async () => {
    const { repo, calls } = makeMockRepo({});
    repo.searchTopConvSummaries = vi.fn(async (_u, _q, k) => {
      expect(k).toBe(3); calls.stage1 += 1; return [];
    });
    const deps = makeDeps(true, repo);
    await runHierarchicalArm(deps, 'u', [0.1], {});
    expect(calls.stage1).toBe(1);
  });

  it('respects per-call topConvs / topSessions / factLimit overrides', async () => {
    const convHits = [{ id: 'c', conversationId: 'C', similarity: 1, summaryText: '' }];
    const sessionHits = [{ id: 's', sessionId: 'S', conversationId: 'C',
      sessionIndex: 0, similarity: 1, summaryText: '' }];
    const { repo } = makeMockRepo({ convHits, sessionHits, memoryIds: ['m'] });
    repo.searchTopConvSummaries = vi.fn(async (_u, _q, k) => {
      expect(k).toBe(7); return convHits;
    });
    repo.searchTopSessionSummaries = vi.fn(async (_u, _ids, _q, k) => {
      expect(k).toBe(20); return sessionHits;
    });
    repo.getMemoryIdsForSessions = vi.fn(async (_u, _ids, k) => {
      expect(k).toBe(200); return ['m'];
    });
    const deps = makeDeps(true, repo);
    await runHierarchicalArm(deps, 'u', [0.1], { topConvs: 7, topSessions: 20, factLimit: 200 });
  });
});

describe('runHierarchicalArm — empty intermediate results', () => {
  it('returns empty without stage-2 / stage-3 when no conv hits', async () => {
    const { repo, calls } = makeMockRepo({ convHits: [] });
    const deps = makeDeps(true, repo);
    const result = await runHierarchicalArm(deps, 'u', [0.1], {});
    expect(result.memoryIds).toEqual([]);
    expect(calls.stage1).toBe(1);
    expect(calls.stage2).toBe(0);
    expect(calls.stage3).toBe(0);
  });

  it('returns matchedConvs but skips stage-3 when no session hits', async () => {
    const { repo, calls } = makeMockRepo({
      convHits: [{ id: 'c', conversationId: 'CONV', similarity: 1, summaryText: '' }],
      sessionHits: [],
    });
    const deps = makeDeps(true, repo);
    const result = await runHierarchicalArm(deps, 'u', [0.1], {});
    expect(result.matchedConvs).toEqual(['CONV']);
    expect(result.matchedSessions).toEqual([]);
    expect(result.memoryIds).toEqual([]);
    expect(calls.stage1).toBe(1);
    expect(calls.stage2).toBe(1);
    expect(calls.stage3).toBe(0);
  });

  it('cost is 0 in all paths (no LLM calls in the arm)', async () => {
    const { repo } = makeMockRepo({
      convHits: [{ id: 'c', conversationId: 'C', similarity: 1, summaryText: '' }],
      sessionHits: [{ id: 's', sessionId: 'S', conversationId: 'C',
        sessionIndex: 0, similarity: 1, summaryText: '' }],
      memoryIds: ['m'],
    });
    const deps = makeDeps(true, repo);
    const result = await runHierarchicalArm(deps, 'u', [0.1], {});
    expect(result.cost).toBe(0);
  });
});
