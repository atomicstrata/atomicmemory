/**
 * Unit tests for query-expansion.ts pure functions.
 * Tests LLM response parsing for entity/concept extraction.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: { queryExpansionMinSimilarity: 0.5 } }));
vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../embedding.js', () => ({ embedText: vi.fn().mockResolvedValue([0.1, 0.2]) }));

const { parseQueryTerms, expandQueryViaEntities } = await import('../query-expansion.js');
const { llm } = await import('../llm.js');

describe('parseQueryTerms', () => {
  it('parses valid JSON with entities and concepts', () => {
    const response = '{"entities":["FastAPI","Redis"],"concepts":["caching","performance"]}';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual(['FastAPI', 'Redis']);
    expect(result.concepts).toEqual(['caching', 'performance']);
  });

  it('handles empty arrays', () => {
    const response = '{"entities":[],"concepts":[]}';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual([]);
    expect(result.concepts).toEqual([]);
  });

  it('returns fallback for invalid JSON', () => {
    const result = parseQueryTerms('not valid json');
    expect(result.entities).toEqual([]);
    expect(result.concepts).toEqual([]);
  });

  it('returns fallback for empty string', () => {
    const result = parseQueryTerms('');
    expect(result.entities).toEqual([]);
    expect(result.concepts).toEqual([]);
  });

  it('filters out non-string values', () => {
    const response = '{"entities":["valid",42,null],"concepts":["ok",true]}';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual(['valid']);
    expect(result.concepts).toEqual(['ok']);
  });

  it('filters out empty strings', () => {
    const response = '{"entities":["","  ","valid"],"concepts":["ok",""]}';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual(['valid']);
    expect(result.concepts).toEqual(['ok']);
  });

  it('handles missing fields gracefully', () => {
    const response = '{"entities":["FastAPI"]}';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual(['FastAPI']);
    expect(result.concepts).toEqual([]);
  });

  it('handles JSON with extra whitespace', () => {
    const response = '  {"entities": ["Redis"], "concepts": ["caching"]}  ';
    const result = parseQueryTerms(response);
    expect(result.entities).toEqual(['Redis']);
    expect(result.concepts).toEqual(['caching']);
  });
});

describe('expandQueryViaEntities runtime config', () => {
  it('prefers explicit runtime config over module config for expansion similarity threshold', async () => {
    (llm.chat as any).mockResolvedValue('{"entities":["Acme"],"concepts":[]}');
    const searchEntities = vi.fn().mockResolvedValue([]);
    const entityRepo = { searchEntities } as any;
    const repo = {} as any;

    await expandQueryViaEntities(
      entityRepo, repo, 'user-1', 'Acme question', [0.1, 0.2], new Set(), 20,
      {
        queryExpansionMinSimilarity: 0.88,
        queryAugmentationMaxEntities: 5,
        queryAugmentationMinSimilarity: 0.4,
      },
    );

    expect(searchEntities).toHaveBeenCalledWith(
      'user-1', expect.any(Array), expect.any(Number), 0.88,
    );
  });
});
