/**
 * Unit tests for contradiction-surfacing — the retrieval-side enrichment
 * counterpart to AUDN bilateral preservation (BEAM CR fix).
 *
 * Verifies:
 *   - When top-K contains a memory with `contradiction_active=true`, the
 *     counterpart memory is injected and a pair is emitted.
 *   - When the surfacing flag is off, top-K is returned unchanged.
 *   - When no top-K hit is flagged, top-K is returned unchanged.
 *   - The CONTRADICTIONS_DETECTED block formats both sides verbatim and
 *     is suppressed when there are no pairs.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildContradictionsBlock,
  enrichTopKWithContradictions,
} from '../contradiction-surfacing.js';
import { QuestionType } from '../answer-format.js';
import type { ContradictionRow, ContradictionsRepository } from '../../db/contradictions-repository.js';
import type { SearchResult } from '../../db/repository-types.js';

function makeMemory(
  id: string,
  content: string,
  flags: { contradictionActive?: boolean } = {},
): SearchResult {
  return {
    id, user_id: 'u-1', content, embedding: [], memory_type: 'semantic',
    importance: 0.5, source_site: 'test', source_url: '', episode_id: null,
    status: 'active', metadata: {}, keywords: '', namespace: null,
    summary: '', overview: '', trust_score: 1,
    observed_at: new Date(0), created_at: new Date(0), last_accessed_at: new Date(0),
    access_count: 0, expired_at: null, deleted_at: null,
    network: 'experience', opinion_confidence: null, observation_subject: null,
    similarity: 0.8, score: 0.8,
    contradiction_active: flags.contradictionActive ?? false,
  } as unknown as SearchResult;
}

function makeRow(overrides: Partial<ContradictionRow> = {}): ContradictionRow {
  return {
    id: 'c-1', userId: 'u-1', conversationId: 'ep-1',
    leftMemoryId: 'm-old', rightMemoryId: 'm-new',
    leftSummary: 'User prefers TypeScript.',
    rightSummary: 'User prefers Python.',
    resolved: false, resolutionNote: null,
    detectedAt: new Date(0),
    ...overrides,
  };
}

function makeRepo(rows: ContradictionRow[]): ContradictionsRepository {
  return {
    record: vi.fn(),
    findActiveByUserAndMemoryIds: vi.fn().mockResolvedValue(rows),
    markContradictionFlagsBilateral: vi.fn(),
  } as unknown as ContradictionsRepository;
}

describe('enrichTopKWithContradictions', () => {
  it('returns input unchanged when surfacing flag is off', async () => {
    const memories = [makeMemory('m-new', 'B', { contradictionActive: true })];
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories,
      contradictions: makeRepo([makeRow()]),
      enabled: false,
      fetchCounterpart: vi.fn(),
    });
    expect(result.memories).toEqual(memories);
    expect(result.pairs).toEqual([]);
  });

  it('returns input unchanged when contradictions store is null', async () => {
    const memories = [makeMemory('m-new', 'B', { contradictionActive: true })];
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories,
      contradictions: null,
      enabled: true,
      fetchCounterpart: vi.fn(),
    });
    expect(result.memories).toEqual(memories);
    expect(result.pairs).toEqual([]);
  });

  it('returns input unchanged when no top-K hit is flagged', async () => {
    const memories = [makeMemory('m-new', 'B', { contradictionActive: false })];
    const fetchCounterpart = vi.fn();
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories,
      contradictions: makeRepo([]),
      enabled: true,
      fetchCounterpart,
    });
    expect(result.memories).toEqual(memories);
    expect(result.pairs).toEqual([]);
    expect(fetchCounterpart).not.toHaveBeenCalled();
  });

  it('injects counterpart when only one side is in top-K', async () => {
    const inTopK = makeMemory('m-new', 'User prefers Python.', { contradictionActive: true });
    const counterpart = makeMemory('m-old', 'User prefers TypeScript.', { contradictionActive: true });
    const fetchCounterpart = vi.fn().mockResolvedValue(counterpart);
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories: [inTopK],
      contradictions: makeRepo([makeRow()]),
      enabled: true,
      fetchCounterpart,
    });
    expect(result.memories).toEqual([inTopK, counterpart]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      leftSummary: 'User prefers TypeScript.',
      rightSummary: 'User prefers Python.',
    });
    expect(fetchCounterpart).toHaveBeenCalledWith('m-old');
  });

  it('does not duplicate counterpart when both sides are already in top-K', async () => {
    const left = makeMemory('m-old', 'A', { contradictionActive: true });
    const right = makeMemory('m-new', 'B', { contradictionActive: true });
    const fetchCounterpart = vi.fn();
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories: [left, right],
      contradictions: makeRepo([makeRow()]),
      enabled: true,
      fetchCounterpart,
    });
    expect(result.memories).toEqual([left, right]);
    expect(result.pairs).toHaveLength(1);
    expect(fetchCounterpart).not.toHaveBeenCalled();
  });

  it('dedupes pairs that share a contradiction id', async () => {
    const inTopK = makeMemory('m-new', 'B', { contradictionActive: true });
    const counterpart = makeMemory('m-old', 'A', { contradictionActive: true });
    const fetchCounterpart = vi.fn().mockResolvedValue(counterpart);
    const result = await enrichTopKWithContradictions({
      userId: 'u-1', memories: [inTopK],
      contradictions: makeRepo([makeRow(), makeRow()]),
      enabled: true,
      fetchCounterpart,
    });
    expect(result.pairs).toHaveLength(1);
  });
});

describe('buildContradictionsBlock', () => {
  const pair = {
    contradictionId: 'c-1',
    leftMemoryId: 'm-old', rightMemoryId: 'm-new',
    leftSummary: 'User prefers TypeScript.',
    rightSummary: 'User prefers Python.',
  };

  it('renders both sides verbatim under the CONTRADICTIONS_DETECTED heading', () => {
    const block = buildContradictionsBlock([pair], QuestionType.CONTRADICTION);
    expect(block).toBeDefined();
    expect(block).toContain('## CONTRADICTIONS_DETECTED');
    expect(block).toContain('"User prefers TypeScript."');
    expect(block).toContain('"User prefers Python."');
  });

  it('returns undefined when no pairs are present', () => {
    expect(buildContradictionsBlock([], QuestionType.CONTRADICTION)).toBeUndefined();
  });

  it('renders for OTHER question types too (pairs are present)', () => {
    const block = buildContradictionsBlock([pair], QuestionType.OTHER);
    expect(block).toBeDefined();
  });
});
