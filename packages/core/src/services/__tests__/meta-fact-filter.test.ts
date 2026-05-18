/**
 * Tests for meta-fact-filter.
 *
 * Covers:
 *   - isMetaFactStatement against the partner-demo / AlignBench distractor pool
 *   - metaFactFilterEnabled env-flag resolution
 *   - filterMetaFacts end-to-end with onDrop telemetry
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_META_FACT_PATTERNS,
  filterMetaFacts,
  getMetaFactDropStats,
  isMetaFactStatement,
  metaFactFilterEnabled,
  resetMetaFactDropStats,
  type MetaFactCandidate,
} from '../meta-fact-filter.js';

describe('isMetaFactStatement', () => {
  it.each([
    "The user asked for the user's name.",
    'The user is asking a question.',
    'The user is me.',
    'The user requested information.',
    'The user said something.',
    'As of May 14, 2026, Apollo is a term mentioned in the conversation.',
    'As of January 2026, the user is a term mentioned in the conversation.',
    'A name was mentioned in the conversation.',
    'The conversation involves the user.',
    'The user has started a conversation.',
  ])('matches the meta-fact shape: "%s"', (statement) => {
    expect(isMetaFactStatement(statement)).toBe(true);
  });

  it.each([
    "User's name is SgtPooki",
    'The user lives in Lisbon.',
    "The user's dog is named Apollo.",
    'As of January 2026, the user lives in Lisbon.',
    'The user prefers oat milk in coffee.',
  ])('does not match a durable user fact: "%s"', (statement) => {
    expect(isMetaFactStatement(statement)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isMetaFactStatement('THE USER IS ME.')).toBe(true);
    expect(isMetaFactStatement('the user asked for the user\'s name.')).toBe(true);
  });

  it.each([null, undefined, 42, {}, [], ''])(
    'returns false on non-string / empty input (%s)',
    (input) => {
      expect(isMetaFactStatement(input as unknown)).toBe(false);
    },
  );
});

describe('metaFactFilterEnabled', () => {
  it('defaults to true when env is empty', () => {
    expect(metaFactFilterEnabled({})).toBe(true);
  });

  it.each(['off', 'OFF', 'false', '0', 'disabled', '  off  '])(
    'disables when ATOMICMEMORY_META_FACT_FILTER=%s',
    (raw) => {
      expect(metaFactFilterEnabled({ ATOMICMEMORY_META_FACT_FILTER: raw })).toBe(false);
    },
  );

  it.each(['on', 'true', '1', 'enabled', 'yes', ''])(
    'keeps enabled for non-disable values like "%s"',
    (raw) => {
      expect(metaFactFilterEnabled({ ATOMICMEMORY_META_FACT_FILTER: raw })).toBe(true);
    },
  );
});

describe('filterMetaFacts', () => {
  const facts: MetaFactCandidate[] = [
    { fact: "User's name is example", },
    { fact: "The user asked for the user's name.", },
    { fact: 'The user is me.', },
    { fact: 'The user lives in some city.', },
    { fact: 'As of May 14, 2026, Apollo is a term mentioned in the conversation.', },
  ];

  it('is a no-op when explicitly disabled', () => {
    const out = filterMetaFacts(facts, { enabled: false });
    expect(out).toEqual(facts);
    expect(out).not.toBe(facts); // shallow copy
  });

  it('drops the three meta-facts by default', () => {
    const out = filterMetaFacts(facts, { enabled: true });
    expect(out.map((f) => f.fact)).toEqual([
      "User's name is example",
      'The user lives in some city.',
    ]);
  });

  it('falls back to .statement when .fact is missing (raw LLM shape)', () => {
    const rawShape: MetaFactCandidate[] = [
      { statement: 'A durable user fact.' },
      { statement: 'The user is me.' },
    ];
    const out = filterMetaFacts(rawShape, { enabled: true });
    expect(out).toHaveLength(1);
    expect(out[0].statement).toBe('A durable user fact.');
  });

  it('invokes onDrop once per dropped fact', () => {
    const dropped: string[] = [];
    filterMetaFacts(facts, {
      enabled: true,
      onDrop: (text) => dropped.push(text),
    });
    expect(dropped).toEqual([
      "The user asked for the user's name.",
      'The user is me.',
      'As of May 14, 2026, Apollo is a term mentioned in the conversation.',
    ]);
  });

  it('swallows onDrop exceptions so extraction never breaks', () => {
    const out = filterMetaFacts(facts, {
      enabled: true,
      onDrop: () => {
        throw new Error('telemetry blew up');
      },
    });
    expect(out).toHaveLength(2);
  });

  it('honours custom patterns (replaces defaults)', () => {
    const out = filterMetaFacts(facts, {
      enabled: true,
      patterns: [/^User's name/],
    });
    // The custom rule drops only the literal "User's name" fact; defaults
    // are NOT applied when a custom set is provided.
    expect(out.map((f) => f.fact)).toEqual([
      "The user asked for the user's name.",
      'The user is me.',
      'The user lives in some city.',
      'As of May 14, 2026, Apollo is a term mentioned in the conversation.',
    ]);
  });

  it('returns input unchanged when pattern set is empty', () => {
    const out = filterMetaFacts(facts, { enabled: true, patterns: [] });
    expect(out).toEqual(facts);
  });

  it('handles missing/non-string fact fields gracefully', () => {
    const weird: MetaFactCandidate[] = [
      { fact: 'The user lives in some city.' },
      { fact: undefined },
      { fact: null as unknown as string },
      { /* no fact field at all */ },
    ];
    const out = filterMetaFacts(weird, { enabled: true });
    // Real fact + the three text-less entries survive (we only drop on a positive match).
    expect(out).toHaveLength(4);
  });

  it('preserves order of kept facts', () => {
    const ordered: MetaFactCandidate[] = [
      { fact: 'fact-a' },
      { fact: 'The user is me.' },
      { fact: 'fact-b' },
      { fact: "The user asked for the user's name." },
      { fact: 'fact-c' },
    ];
    const out = filterMetaFacts(ordered, { enabled: true });
    expect(out.map((f) => f.fact)).toEqual(['fact-a', 'fact-b', 'fact-c']);
  });
});

describe('DEFAULT_META_FACT_PATTERNS shape', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_META_FACT_PATTERNS)).toBe(true);
  });
  it('contains the five anchored families', () => {
    expect(DEFAULT_META_FACT_PATTERNS).toHaveLength(5);
  });
});

describe('drop telemetry (counters + structured log)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMetaFactDropStats();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    infoSpy.mockRestore();
    resetMetaFactDropStats();
  });

  it('starts with all counters at zero', () => {
    const stats = getMetaFactDropStats();
    expect(stats.total).toBe(0);
    expect(stats.byPattern.every((n) => n === 0)).toBe(true);
  });

  it('increments per-pattern + total counters by default', () => {
    filterMetaFacts(
      [
        { fact: "The user asked for the user's name." }, // pattern 0
        { fact: 'The user is me.' }, // pattern 0
        { fact: 'A name was mentioned.' }, // pattern 2
        { fact: 'Durable fact, untouched.' },
      ],
      { enabled: true, source: 'unit' },
    );
    const stats = getMetaFactDropStats();
    expect(stats.total).toBe(3);
    expect(stats.byPattern[0]).toBe(2);
    expect(stats.byPattern[2]).toBe(1);
  });

  it('emits structured drop lines tagged with source', () => {
    filterMetaFacts(
      [{ fact: 'The user is me.' }],
      { enabled: true, source: 'migration' },
    );
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = infoSpy.mock.calls[0]![0];
    expect(typeof line).toBe('string');
    expect(line).toMatch(/^\[meta-fact-filter\] dropped pattern=\d+ len=\d+ source=migration$/);
  });

  it('explicit onDrop: null suppresses both counters and structured log', () => {
    filterMetaFacts(
      [{ fact: 'The user is me.' }],
      { enabled: true, onDrop: null, source: 'unit' },
    );
    expect(getMetaFactDropStats().total).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('custom onDrop function suppresses default telemetry', () => {
    const seen: number[] = [];
    filterMetaFacts(
      [{ fact: 'The user is me.' }],
      { enabled: true, onDrop: (_, i) => seen.push(i), source: 'unit' },
    );
    expect(seen).toEqual([0]);
    // Counters NOT bumped — custom hook owns observability now.
    expect(getMetaFactDropStats().total).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('resetMetaFactDropStats clears all counters', () => {
    filterMetaFacts([{ fact: 'The user is me.' }], { enabled: true });
    expect(getMetaFactDropStats().total).toBe(1);
    resetMetaFactDropStats();
    expect(getMetaFactDropStats().total).toBe(0);
  });
});
