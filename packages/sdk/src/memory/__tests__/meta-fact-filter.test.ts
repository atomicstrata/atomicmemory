/**
 * @file MetaFactFilter unit tests
 *
 * Covers the three public surfaces of meta-fact-filter:
 *   - DEFAULT_META_FACT_PATTERNS / isMetaFact: pattern matching
 *   - resolveMetaFactPatterns: replace vs extend modes
 *   - filterMetaFacts: end-to-end drop with onDrop telemetry
 *
 * Item shapes are deliberately the same the SDK uses (SearchResult.memory.content)
 * to keep the integration risk on the call-site low.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_META_FACT_PATTERNS,
  filterMetaFacts,
  isMetaFact,
  resolveMetaFactPatterns,
  type MetaFactFilterConfig,
} from '../meta-fact-filter';

describe('isMetaFact', () => {
  it.each([
    "The user asked for the user's name.",
    "The user is asking a question.",
    'The user is me.',
    'The user requested information.',
    'The user said something.',
    'As of May 14, 2026, Apollo is a term mentioned in the conversation.',
    'As of January 2026, the user is a term mentioned in the conversation.',
    'A name was mentioned in the conversation.',
    'The conversation involves the user.',
    'The user has started a conversation.',
  ])('matches the partner-demo meta-fact shape: "%s"', (content) => {
    expect(isMetaFact(content)).toBe(true);
  });

  it.each([
    "User's name is SgtPooki",
    'The user lives in Lisbon.',
    "The user's dog is named Apollo.",
    'The user prefers oat-milk flat whites.',
    'As of January 2026, the user lives in Lisbon.', // temporal anchor on a real fact, not a meta-fact
  ])('does not match a durable user fact: "%s"', (content) => {
    expect(isMetaFact(content)).toBe(false);
  });

  it('is case-insensitive on the leading "The user"', () => {
    expect(isMetaFact('THE USER ASKED FOR THE USER\'S NAME.')).toBe(true);
    expect(isMetaFact('the user is me.')).toBe(true);
  });

  it.each([null, undefined, 42, {}, [], ''])(
    'returns false on non-string / empty input (%s)',
    (input) => {
      expect(isMetaFact(input as unknown)).toBe(false);
    },
  );

  it('uses caller-supplied patterns instead of defaults when provided', () => {
    const custom = [/^transcript: /i];
    expect(isMetaFact('transcript: hello', custom)).toBe(true);
    // The default rules would NOT match this; with custom rules, it does.
    expect(isMetaFact("The user is me.", custom)).toBe(false);
  });
});

describe('resolveMetaFactPatterns', () => {
  it('returns the default set when patterns is omitted', () => {
    const config: MetaFactFilterConfig = { enabled: true };
    expect(resolveMetaFactPatterns(config)).toBe(DEFAULT_META_FACT_PATTERNS);
  });

  it("'replace' mode (default) returns only the caller's patterns", () => {
    const config: MetaFactFilterConfig = {
      enabled: true,
      patterns: [/^foo$/],
    };
    const resolved = resolveMetaFactPatterns(config);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(/^foo$/);
  });

  it("'extend' mode unions caller patterns with defaults", () => {
    const config: MetaFactFilterConfig = {
      enabled: true,
      patterns: [/^foo$/],
      mode: 'extend',
    };
    const resolved = resolveMetaFactPatterns(config);
    expect(resolved.length).toBe(DEFAULT_META_FACT_PATTERNS.length + 1);
    expect(resolved[0]).toEqual(/^foo$/);
  });
});

describe('filterMetaFacts', () => {
  interface FakeResult {
    memory: { content: string };
    score: number;
  }
  const items: FakeResult[] = [
    { memory: { content: "User's name is SgtPooki" }, score: 0.51 },
    { memory: { content: "The user asked for the user's name." }, score: 0.40 },
    { memory: { content: 'The user is me.' }, score: 0.35 },
    { memory: { content: 'The user lives in Lisbon.' }, score: 0.32 },
  ];

  it('is a no-op when filter is disabled', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: false,
    });
    expect(out).toEqual(items);
    expect(out).not.toBe(items); // returns a copy
  });

  it('drops items whose content matches the default patterns', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
    });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.memory.content)).toEqual([
      "User's name is SgtPooki",
      'The user lives in Lisbon.',
    ]);
  });

  it('preserves original order of kept items', () => {
    const ordered: FakeResult[] = [
      { memory: { content: 'real-1' }, score: 1 },
      { memory: { content: 'The user is me.' }, score: 0.9 },
      { memory: { content: 'real-2' }, score: 0.8 },
      { memory: { content: 'The user asked for the user\'s name.' }, score: 0.7 },
      { memory: { content: 'real-3' }, score: 0.6 },
    ];
    const out = filterMetaFacts(ordered, (r) => r.memory.content, {
      enabled: true,
    });
    expect(out.map((r) => r.memory.content)).toEqual(['real-1', 'real-2', 'real-3']);
  });

  it('invokes onDrop once per dropped item with pattern index', () => {
    const dropped: Array<{ content: string; index: number }> = [];
    filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
      onDrop: (content, index) => dropped.push({ content, index }),
    });
    expect(dropped).toHaveLength(2);
    expect(dropped[0].content).toBe("The user asked for the user's name.");
    expect(dropped[1].content).toBe('The user is me.');
    // Both match pattern index 0 (the first DEFAULT pattern) — which is the
    // catch-all "The user (asked|requested|said|is asking|is me)" rule.
    expect(dropped[0].index).toBe(0);
    expect(dropped[1].index).toBe(0);
  });

  it('swallows onDrop exceptions so filtering never breaks recall', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
      onDrop: () => {
        throw new Error('telemetry blew up');
      },
    });
    expect(out).toHaveLength(2);
  });

  it('honours custom patterns in replace mode', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
      patterns: [/^User's name/],
    });
    // Custom pattern drops "User's name is SgtPooki" but lets meta-facts through.
    expect(out.map((r) => r.memory.content)).toEqual([
      "The user asked for the user's name.",
      'The user is me.',
      'The user lives in Lisbon.',
    ]);
  });

  it('honours custom patterns in extend mode (union with defaults)', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
      patterns: [/^User's name/],
      mode: 'extend',
    });
    // Both the custom rule AND the defaults fire.
    expect(out.map((r) => r.memory.content)).toEqual([
      'The user lives in Lisbon.',
    ]);
  });

  it('handles non-string content gracefully without dropping the item', () => {
    const weird = [
      ...items,
      { memory: { content: null as unknown as string }, score: 0.1 },
    ];
    const out = filterMetaFacts(weird, (r) => r.memory.content, {
      enabled: true,
    });
    // Real facts + the null-content item survive; meta-facts dropped.
    expect(out).toHaveLength(3);
  });

  it('returns the original list when the resolved pattern set is empty', () => {
    const out = filterMetaFacts(items, (r) => r.memory.content, {
      enabled: true,
      patterns: [],
    });
    expect(out).toEqual(items);
  });
});
