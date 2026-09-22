/**
 * Documents compact extraction as a reduced-capability opt-in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../llm.js', () => ({ llm: { chat: vi.fn() } }));
vi.mock('../fact-normalization.js', () => ({
  normalizeExtractedFacts: (facts: unknown[]) => facts,
}));
vi.mock('../../config.js', () => ({
  config: { extractionMaxTokens: 768, audnMaxTokens: 128 },
}));

const { llm } = await import('../llm.js');
const { EXTRACTION_PROMPT_COMPACT, extractFacts } = await import('../extraction.js');

const mockLlmChat = vi.mocked(llm.chat);

beforeEach(() => {
  mockLlmChat.mockReset();
});

describe('compact extraction product contract', () => {
  it('documents reduced capability on the compact prompt', () => {
    expect(EXTRACTION_PROMPT_COMPACT).toContain("Never record the assistant's commentary");
    expect(EXTRACTION_PROMPT_COMPACT).not.toContain('DO extract specific factual content from assistant responses');
    expect(EXTRACTION_PROMPT_COMPACT).not.toContain('CONTACT INFO');
  });

  it('derives keywords when compact sanitization empties an invalid array', async () => {
    const fact = 'User prefers PostgreSQL over MongoDB.';
    mockLlmChat.mockResolvedValueOnce(
      JSON.stringify({ memories: [{ fact, keywords: [null, '', 42] }] }),
    );
    const facts = await extractFacts('User: I prefer PostgreSQL over MongoDB.', {
      promptVariant: 'compact',
    });
    expect(facts[0]?.keywords).toEqual(['PostgreSQL', 'MongoDB']);
  });

  it('does not extract assistant recommendations under compact mode', async () => {
    mockLlmChat.mockResolvedValueOnce(JSON.stringify({ memories: [] }));
    const facts = await extractFacts(
      'Assistant: You should migrate to PostgreSQL for production.\nUser: Thanks.',
      { promptVariant: 'compact' },
    );
    expect(facts).toEqual([]);
    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: EXTRACTION_PROMPT_COMPACT }),
      ]),
      expect.any(Object),
    );
  });
});
