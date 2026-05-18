import { describe, expect, it, vi } from 'vitest';
import { fetchReflectionsForQuery, type ReflectRetrievalDeps } from '../reflect-retrieval.js';
import { QuestionType } from '../answer-format.js';

const reflection = (text: string): any => ({
  id: 'r1',
  userId: 'u',
  conversationId: 'c',
  observation: text,
  observationType: 'event_summary',
  evidenceMemoryIds: ['m1'],
  embedding: [],
  createdAt: new Date(),
});

describe('fetchReflectionsForQuery', () => {
  it('returns empty when reflect retrieval disabled', async () => {
    const deps: ReflectRetrievalDeps = {
      reflections: { findSimilar: vi.fn() } as any,
      embed: vi.fn(),
      topK: 5,
      enabled: false,
    };
    const out = await fetchReflectionsForQuery(deps, 'u', 'How many?', QuestionType.NUMERIC_COUNT);
    expect(out).toEqual([]);
    expect(deps.reflections.findSimilar).not.toHaveBeenCalled();
  });

  it('returns empty when question type is OTHER', async () => {
    const deps: ReflectRetrievalDeps = {
      reflections: { findSimilar: vi.fn() } as any,
      embed: vi.fn(),
      topK: 5,
      enabled: true,
    };
    const out = await fetchReflectionsForQuery(deps, 'u', 'unrelated', QuestionType.OTHER);
    expect(out).toEqual([]);
    expect(deps.reflections.findSimilar).not.toHaveBeenCalled();
  });

  it('embeds and fetches top-K when type is in the routed set', async () => {
    const findSimilar = vi.fn().mockResolvedValue([reflection('R1'), reflection('R2')]);
    const embed = vi.fn().mockResolvedValue([0.1, 0.2]);
    const deps: ReflectRetrievalDeps = {
      reflections: { findSimilar } as any,
      embed,
      topK: 5,
      enabled: true,
    };
    const out = await fetchReflectionsForQuery(
      deps,
      'u',
      'Summary please.',
      QuestionType.SUMMARY,
    );
    expect(embed).toHaveBeenCalledWith('Summary please.');
    expect(findSimilar).toHaveBeenCalledWith('u', [0.1, 0.2], 5);
    expect(out).toHaveLength(2);
  });
});
