/**
 * Integration test — extract → normalize → anchor → enrich → filter pipeline.
 *
 * Unit tests cover the filter primitive in isolation. This test exercises
 * the *wiring* in `extractFacts()` so a regression in the post-process
 * chain (e.g. someone re-orders the pipeline and runs filterMetaFacts
 * before enrichExtractedFacts) is caught here, not in production.
 *
 * The LLM module is mocked to return a controlled mixed batch of durable
 * facts and meta-facts. The full real post-process runs against that
 * output; the assertion is that durable facts survive intact and
 * meta-facts are dropped + counted in the telemetry surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the entire llm module before the SUT imports it. Hoisted by vitest
// per `vi.mock` semantics, so this beats the import order in extraction.ts.
// `vi.hoisted` is required so `chatMock` exists when the factory runs.
const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));
vi.mock('../llm.js', () => ({
  llm: {
    chat: chatMock,
  },
}));

// Imports after mock so extractFacts picks up the mocked llm.
import { extractFacts } from '../extraction.js';
import {
  getMetaFactDropStats,
  resetMetaFactDropStats,
} from '../meta-fact-filter.js';

const MIXED_LLM_RESPONSE = JSON.stringify({
  memories: [
    {
      statement: 'User prefers oat-milk flat whites for morning coffee.',
      headline: 'Prefers oat-milk flat whites',
      importance: 0.7,
      type: 'preference',
      keywords: ['coffee', 'oat-milk', 'flat-white'],
      entities: [{ name: 'oat-milk flat white', type: 'product' }],
      relations: [],
    },
    {
      statement: "The user asked for the user's name.",
      headline: 'User asked about name',
      importance: 0.3,
      type: 'knowledge',
      keywords: [],
      entities: [],
      relations: [],
    },
    {
      statement: 'User works as a software engineer at a startup.',
      headline: 'Software engineer at a startup',
      importance: 0.8,
      type: 'project',
      keywords: ['software', 'engineer', 'startup'],
      entities: [{ name: 'startup', type: 'organization' }],
      relations: [],
    },
    {
      statement: 'The user is me.',
      headline: 'User is me',
      importance: 0.2,
      type: 'knowledge',
      keywords: [],
      entities: [],
      relations: [],
    },
    {
      statement: 'As of May 14, 2026, golden retriever is a term mentioned in the conversation.',
      headline: 'Golden retriever mentioned',
      importance: 0.2,
      type: 'knowledge',
      keywords: ['golden retriever'],
      entities: [],
      relations: [],
    },
  ],
});

describe('extractFacts integration — meta-fact filter wiring', () => {
  beforeEach(() => {
    chatMock.mockReset();
    chatMock.mockResolvedValue(MIXED_LLM_RESPONSE);
    resetMetaFactDropStats();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMetaFactDropStats();
  });

  it('drops meta-facts but preserves durable user facts', async () => {
    const result = await extractFacts(
      'User: I love oat-milk flat whites in the morning.\nAssistant: Got it.',
    );

    // Three meta-facts in the mock response (rows 1, 3, 4) should be dropped.
    // Two durable facts (rows 0, 2) should remain.
    const statements = result.map((f) => f.fact);
    expect(statements).toContain('User prefers oat-milk flat whites for morning coffee.');
    expect(statements).toContain('User works as a software engineer at a startup.');

    // No meta-fact survived.
    expect(statements).not.toContain("The user asked for the user's name.");
    expect(statements).not.toContain('The user is me.');
    expect(statements).not.toContain(
      'As of May 14, 2026, golden retriever is a term mentioned in the conversation.',
    );
  });

  it('updates drop telemetry by source=extract', async () => {
    await extractFacts('User: short input.');

    const stats = getMetaFactDropStats();
    expect(stats.total).toBe(3);
    // Pattern 0 (the user asked/requested/said/is asking/is me) fires
    // for two of the three meta-facts; pattern 1 (As of ..., X is a
    // term mentioned ...) fires for the third.
    expect(stats.byPattern[0]).toBe(2);
    expect(stats.byPattern[1]).toBe(1);
  });

  it('is a no-op when ATOMICMEMORY_META_FACT_FILTER is disabled at runtime', async () => {
    // Stash + flip the env flag before calling.
    const prev = process.env.ATOMICMEMORY_META_FACT_FILTER;
    process.env.ATOMICMEMORY_META_FACT_FILTER = 'off';
    try {
      const result = await extractFacts('User: anything.');
      const statements = result.map((f) => f.fact);
      // All five extracted facts should pass through unchanged.
      expect(statements).toHaveLength(5);
      expect(statements).toContain("The user asked for the user's name.");
      // And the drop counter stays at zero.
      expect(getMetaFactDropStats().total).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ATOMICMEMORY_META_FACT_FILTER;
      else process.env.ATOMICMEMORY_META_FACT_FILTER = prev;
    }
  });

  it('survives an empty LLM response without throwing', async () => {
    chatMock.mockResolvedValue('');
    const result = await extractFacts('User: hi');
    expect(result).toEqual([]);
    expect(getMetaFactDropStats().total).toBe(0);
  });

  it('survives a non-JSON LLM response without throwing', async () => {
    chatMock.mockResolvedValue('the model rambled instead of returning JSON');
    const result = await extractFacts('User: hi');
    expect(result).toEqual([]);
    expect(getMetaFactDropStats().total).toBe(0);
  });

  it('survives an all-meta-fact LLM response by returning an empty list', async () => {
    chatMock.mockResolvedValue(
      JSON.stringify({
        memories: [
          {
            statement: "The user asked for the user's name.",
            headline: 'meta',
            importance: 0.2,
            type: 'knowledge',
            keywords: [],
            entities: [],
            relations: [],
          },
          {
            statement: 'The user is me.',
            headline: 'meta',
            importance: 0.2,
            type: 'knowledge',
            keywords: [],
            entities: [],
            relations: [],
          },
        ],
      }),
    );
    const result = await extractFacts('User: hi');
    expect(result).toEqual([]);
    expect(getMetaFactDropStats().total).toBe(2);
  });
});
