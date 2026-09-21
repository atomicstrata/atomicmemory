/**
 * Unit tests for extractFacts JSON parse hardening (ATO-2185).
 * Covers trailing prose, fenced JSON, concatenated objects, truncated repair,
 * and valid empty memories — without changing quickExtractFacts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../../config.js', () => ({
  config: { extractionMaxTokens: 4096, audnMaxTokens: 2048 },
}));
vi.mock('../fact-normalization.js', () => ({
  normalizeExtractedFacts: (facts: unknown[]) => facts,
}));
vi.mock('../supplemental-extraction.js', () => ({
  mergeSupplementalFacts: (facts: unknown[]) => facts,
}));

const { llm } = await import('../llm.js');
const {
  extractFacts,
  getExtractParseFailureCount,
  resetExtractParseFailureCount,
} = await import('../extraction.js');

const mockLlmChat = vi.mocked(llm.chat);

const MEMORY_FACT = {
  fact: 'User prefers Vite over Webpack.',
  type: 'preference',
  headline: 'Prefers Vite',
  importance: 0.7,
  keywords: ['Vite', 'Webpack'],
  entities: [],
  relations: [],
};

const VALID_MEMORIES = JSON.stringify({ memories: [MEMORY_FACT] });

beforeEach(() => {
  mockLlmChat.mockReset();
  resetExtractParseFailureCount();
});

describe('extractFacts — JSON parse hardening (ATO-2185)', () => {
  it('parses JSON followed by trailing prose', async () => {
    mockLlmChat.mockResolvedValueOnce(
      `${VALID_MEMORIES}\n\nI extracted one preference about Vite.`,
    );
    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toContain('Vite');
    expect(mockLlmChat).toHaveBeenCalledTimes(1);
  });

  it('parses fenced JSON with trailing text after the fence', async () => {
    mockLlmChat.mockResolvedValueOnce(
      `\`\`\`json\n${VALID_MEMORIES}\n\`\`\`\nThanks, here is the extraction.`,
    );
    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toContain('Vite');
  });

  it('uses the first object when two JSON objects are concatenated', async () => {
    const second = JSON.stringify({
      memories: [{ fact: 'User prefers Parcel exclusively.', type: 'preference' }],
    });
    mockLlmChat.mockResolvedValueOnce(`${VALID_MEMORIES}\n${second}`);
    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toContain('Vite');
    expect(facts[0]?.fact).not.toContain('Parcel');
  });

  it('repairs truncated memories arrays and keeps complete entries', async () => {
    const truncated =
      '{"memories":[{"fact":"User prefers Vite over Webpack.","type":"preference"},{"fact":"User uses React';
    mockLlmChat.mockResolvedValueOnce(truncated);
    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0]?.fact).toContain('Vite');
  });

  it('treats an empty memories array as valid success without retry', async () => {
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({ memories: [] }));
    const facts = await extractFacts('User: hello');
    expect(facts).toEqual([]);
    expect(mockLlmChat).toHaveBeenCalledTimes(1);
    expect(getExtractParseFailureCount()).toBe(0);
  });

  it('retries once with a JSON-only nudge when substantial content will not parse', async () => {
    mockLlmChat
      .mockResolvedValueOnce('Sure!\n\nHere is nonsense {not-json at all} trailing prose filler.')
      .mockResolvedValueOnce(VALID_MEMORIES);

    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts).toHaveLength(1);
    expect(mockLlmChat).toHaveBeenCalledTimes(2);
    const retrySystem = mockLlmChat.mock.calls[1]?.[0]?.[0]?.content as string;
    expect(retrySystem).toContain('ONLY the JSON object');
    expect(getExtractParseFailureCount()).toBe(0);
  });

  it('logs a parse failure metric when retry still cannot parse', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockLlmChat
      .mockResolvedValueOnce('Sure!\n\nHere is nonsense {not-json at all} trailing prose filler.')
      .mockResolvedValueOnce('Still broken {also not json} with more prose here.');

    const facts = await extractFacts('User: I prefer Vite over Webpack.');
    expect(facts).toEqual([]);
    expect(mockLlmChat).toHaveBeenCalledTimes(2);
    expect(getExtractParseFailureCount()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[extractFacts] parse failed after retry'),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('Still broken');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('not-json');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('not-json');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('also not json');
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
