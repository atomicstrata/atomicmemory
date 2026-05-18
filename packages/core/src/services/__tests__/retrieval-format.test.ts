/**
 * Unit tests for retrieval-format injection and citation helpers.
 * Tests formatting, staged loading, citation building, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchResult } from './test-fixtures.js';

const mockConfig: Record<string, unknown> = {
  stagedLoadingEnabled: false,
  packagingUseObservedAt: false,
  packagingDualDate: false,
  timelineChannelEnabled: false,
  answerOnlyRetrievalFilter: false,
  retrievalDedupEnabled: false,
  answerFormatAlignmentEnabled: false,
  eventChainPackagingEnabled: false,
};

vi.mock('../../config.js', () => ({
  config: mockConfig,
}));

const {
  buildCitations,
  buildInjection,
  computePackagingSignal,
  formatInjection,
  formatSimpleInjection,
  formatTieredInjection,
} = await import('../retrieval-format.js');

import type { Reflection } from '../../db/reflections-repository.js';

function makeResult(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({
    id: 'mem-1', content: 'TypeScript is great', embedding: [0.1],
    importance: 0.7, source_site: 'chatgpt',
    created_at: new Date('2026-01-15T00:00:00Z'), access_count: 1,
    similarity: 0.85, score: 0.9,
    ...overrides,
  });
}

describe('buildCitations', () => {
  it('returns citation per memory', () => {
    const results = [makeResult({ id: 'a' }), makeResult({ id: 'b' })];
    const citations = buildCitations(results);
    expect(citations).toHaveLength(2);
    expect(citations[0].memory_id).toBe('a');
    expect(citations[1].memory_id).toBe('b');
  });

  it('includes source_site and importance', () => {
    const citation = buildCitations([makeResult()])[0];
    expect(citation.source_site).toBe('chatgpt');
    expect(citation.importance).toBe(0.7);
  });

  it('formats created_at as ISO string', () => {
    const citation = buildCitations([makeResult()])[0];
    expect(citation.created_at).toBe('2026-01-15T00:00:00.000Z');
  });

  it('returns empty array for no results', () => {
    expect(buildCitations([])).toEqual([]);
  });
});

describe('formatInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatInjection([])).toBe('');
  });

  it('wraps memories in atomicmem_context XML', () => {
    const result = formatInjection([makeResult()]);
    expect(result).toContain('<atomicmem_context count="1">');
    expect(result).toContain('</atomicmem_context>');
  });

  it('includes memory content in full mode', () => {
    const result = formatInjection([makeResult({ content: 'hello world' })]);
    expect(result).toContain('hello world');
  });

  it('escapes XML special characters', () => {
    const result = formatInjection([makeResult({ content: 'a < b & c > d' })]);
    expect(result).toContain('a &lt; b &amp; c &gt; d');
  });

  it('includes similarity and score attributes', () => {
    const result = formatInjection([makeResult({ similarity: 0.85, score: 0.9 })]);
    expect(result).toContain('similarity="0.85"');
    expect(result).toContain('score="0.90"');
  });

  it('includes memory_id attribute', () => {
    const result = formatInjection([makeResult({ id: 'mem-abc' })]);
    expect(result).toContain('memory_id="mem-abc"');
  });

  it('uses staged mode when config enabled', () => {
    mockConfig.stagedLoadingEnabled = true;
    const result = formatInjection([makeResult({ summary: 'short summary' })]);
    expect(result).toContain('mode="staged"');
    expect(result).toContain('staged="true"');
    expect(result).toContain('short summary');
    expect(result).toContain('expand_hint');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('prefers explicit staged-loading option over module config', () => {
    mockConfig.stagedLoadingEnabled = false;
    const result = formatInjection(
      [makeResult({ summary: 'short summary' })],
      { stagedLoadingEnabled: true },
    );

    expect(result).toContain('mode="staged"');
    expect(result).toContain('short summary');
    expect(result).toContain('expand_hint');
  });

  it('prefers explicit full-loading option over enabled module config', () => {
    mockConfig.stagedLoadingEnabled = true;
    const result = formatInjection(
      [makeResult({ content: 'full content', summary: 'short summary' })],
      { stagedLoadingEnabled: false },
    );

    expect(result).not.toContain('mode="staged"');
    expect(result).not.toContain('expand_hint');
    expect(result).toContain('full content');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('staged mode truncates content when no summary', () => {
    mockConfig.stagedLoadingEnabled = true;
    const longContent = 'A'.repeat(100);
    const result = formatInjection([makeResult({ content: longContent, summary: '' })]);
    expect(result).toContain('A'.repeat(60) + '...');
    mockConfig.stagedLoadingEnabled = false;
  });

  it('formats multiple memories with indexes', () => {
    const results = [
      makeResult({ id: 'a', content: 'first' }),
      makeResult({ id: 'b', content: 'second' }),
    ];
    const result = formatInjection(results);
    expect(result).toContain('index="1"');
    expect(result).toContain('index="2"');
    expect(result).toContain('count="2"');
  });

  it('sorts memories chronologically regardless of input order', () => {
    const results = [
      makeResult({ content: 'Later fact', created_at: new Date('2026-03-01') }),
      makeResult({ content: 'Earlier fact', created_at: new Date('2026-01-01') }),
    ];
    const result = formatInjection(results);
    const earlierIdx = result.indexOf('Earlier fact');
    const laterIdx = result.indexOf('Later fact');
    expect(earlierIdx).toBeLessThan(laterIdx);
  });
});

describe('formatTieredInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatTieredInjection([], [])).toBe('');
  });

  it('renders each memory at its assigned tier with kind label', () => {
    const memories = [
      makeResult({ id: 'a', summary: 'Summary A', content: 'Full content A' }),
      makeResult({ id: 'b', overview: 'Overview B', content: 'Full content B', memory_type: 'composite' }),
    ];
    const assignments = [
      { memoryId: 'a', tier: 'L0' as const, estimatedTokens: 5 },
      { memoryId: 'b', tier: 'L1' as const, estimatedTokens: 10 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).toContain('- [2026-01-15] [L0] [atomic] Summary A');
    expect(result).toContain('- [2026-01-15] [L1] [composite] Overview B');
  });

  it('includes compact expandable ids for non-L2 memories', () => {
    const memories = [
      makeResult({ id: 'a' }),
      makeResult({ id: 'b' }),
    ];
    const assignments = [
      { memoryId: 'a', tier: 'L2' as const, estimatedTokens: 50 },
      { memoryId: 'b', tier: 'L0' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).toContain('Expandable IDs: b');
    expect(result).not.toContain('Expandable IDs: a');
  });

  it('omits expandable ids when all memories are L2', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [
      { memoryId: 'a', tier: 'L2' as const, estimatedTokens: 50 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).not.toContain('Expandable IDs');
  });

  it('renders only memories named by assignments — extras in input are not silently L0-rendered', () => {
    const memories = [
      makeResult({ id: 'kept', summary: 'KEEP-A' }),
      makeResult({ id: 'excluded', summary: 'DROP-X' }),
    ];
    const assignments = [
      { memoryId: 'kept', tier: 'L0' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).toContain('KEEP-A');
    expect(result).not.toContain('DROP-X');
  });

  it('throws when an assignment references a memory id not in the input list', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [
      { memoryId: 'missing', tier: 'L0' as const, estimatedTokens: 5 },
    ];
    expect(() => formatTieredInjection(memories, assignments)).toThrow(/missing/);
  });

  it('avoids XML overhead in tiered mode', () => {
    const memories = [makeResult({ id: 'a' })];
    const assignments = [
      { memoryId: 'a', tier: 'L1' as const, estimatedTokens: 10 },
    ];
    const result = formatTieredInjection(memories, assignments);
    expect(result).not.toContain('<atomicmem_context');
    expect(result).not.toContain('<memory');
  });

  it('retains temporal gap summaries in tiered mode', () => {
    const memories = [
      makeResult({ id: 'met', content: 'James met Samantha.', created_at: new Date('2022-08-10T00:00:00Z') }),
      makeResult({ id: 'move', content: 'James and Samantha decided to move in.', created_at: new Date('2022-10-31T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'met', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'move', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(memories, assignments);

    expect(result).toContain('Timeline:');
    expect(result).toContain('2022-08-10 → 2022-10-31: ~3 months');
    expect(result).toContain('Key temporal evidence:');
    expect(result).toContain('- 2022-08-10: James met Samantha.');
    expect(result).toContain('- 2022-10-31: James and Samantha decided to move in.');
  });

  it('adds repeated-event endpoints when the query asks for first and second events', () => {
    const memories = [
      makeResult({ id: 'first', content: "Sam had a check-up with Sam's doctor.", created_at: new Date('2023-05-24T00:00:00Z') }),
      makeResult({ id: 'second', content: "Sam had a doctor's appointment.", created_at: new Date('2023-08-15T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'first', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'second', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(
      memories,
      assignments,
      "How many months lapsed between Sam's first and second doctor's appointment?",
    );

    expect(result).toContain('Repeated event endpoints:');
    expect(result).toContain('elapsed between endpoints: ~3 months (83 days)');
  });

  it('suppresses the generic timeline summary when query-aware temporal evidence is present', () => {
    const memories = [
      makeResult({ id: 'first', content: 'Avery completed the first maintenance appointment.', created_at: new Date('2023-05-24T00:00:00Z') }),
      makeResult({ id: 'second', content: 'Avery completed a second maintenance appointment.', created_at: new Date('2023-08-15T00:00:00Z') }),
      makeResult({ id: 'plan', content: 'Avery planned to schedule another maintenance appointment in January.', created_at: new Date('2024-01-10T00:00:00Z') }),
    ];
    const assignments = [
      { memoryId: 'first', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'second', tier: 'L2' as const, estimatedTokens: 5 },
      { memoryId: 'plan', tier: 'L2' as const, estimatedTokens: 5 },
    ];
    const result = formatTieredInjection(
      memories,
      assignments,
      "How many months lapsed between Avery's first and second maintenance appointment?",
    );

    expect(result).toContain('Repeated event endpoints:');
    expect(result).not.toContain('Timeline:');
    expect(result).not.toContain('Key temporal evidence:');
    expect(result).not.toContain('2024-01-10 →');
  });
});

describe('formatSimpleInjection', () => {
  it('returns empty string for no memories', () => {
    expect(formatSimpleInjection([])).toBe('');
  });

  it('formats memories as dash-delimited lines with date and kind', () => {
    const memories = [
      makeResult({ content: 'Fact A', namespace: 'ns-a', created_at: new Date('2026-01-15') }),
      makeResult({ content: 'Fact B', namespace: 'ns-b', created_at: new Date('2026-02-20'), memory_type: 'composite' }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('- [2026-01-15] [context] Fact A');
    expect(result).toContain('- [2026-02-20] [context] Fact B');
    const memoryLines = result.split('\n').filter((l) => l.startsWith('- ['));
    expect(memoryLines).toHaveLength(2);
  });

  it('sorts memories chronologically regardless of input order', () => {
    const memories = [
      makeResult({ id: 'c', content: 'Third', created_at: new Date('2026-03-01'), score: 0.9 }),
      makeResult({ id: 'a', content: 'First', created_at: new Date('2026-01-01'), score: 0.7 }),
      makeResult({ id: 'b', content: 'Second', created_at: new Date('2026-02-01'), score: 0.8 }),
    ];
    const result = formatSimpleInjection(memories);
    const firstIdx = result.indexOf('First');
    const secondIdx = result.indexOf('Second');
    const thirdIdx = result.indexOf('Third');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it('uses timeline-pack format for multi-date namespace groups', () => {
    const memories = [
      makeResult({ id: 'old', content: 'User prefers MongoDB.', namespace: 'database', created_at: new Date('2026-01-10') }),
      makeResult({ id: 'new', content: 'User switched to PostgreSQL.', namespace: 'database', created_at: new Date('2026-03-15') }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('### Timeline: database');
    expect(result).toContain('[CURRENT] User switched to PostgreSQL.');
    expect(result).not.toContain('### Subject: database');
  });

  it('uses flat subject format for single-date namespace groups', () => {
    const memories = [
      makeResult({ content: 'Fact A', namespace: 'tools', created_at: new Date('2026-01-15T10:00:00Z') }),
      makeResult({ id: 'mem-2', content: 'Fact B', namespace: 'tools', created_at: new Date('2026-01-15T18:00:00Z') }),
    ];
    const result = formatSimpleInjection(memories);
    expect(result).toContain('### Subject: tools');
    expect(result).not.toContain('### Timeline:');
    expect(result).not.toContain('[CURRENT]');
  });
});

describe('buildInjection query-term visibility', () => {
  it('keeps the exact query term visible in the final temporal injection', () => {
    const result = buildInjection([
      makeResult({
        id: 'workshop',
        content: 'Caroline attended an LGBTQ+ counseling workshop for therapists. '.repeat(12),
        summary: 'Caroline attended LGBTQ+ counseling...',
        overview: 'Caroline attended an LGBTQ+ counseling workshop for therapists.',
        score: 0.4,
      }),
    ], 'What workshop did Caroline attend recently?', 'tiered', 100);

    expect(result.injectionText).toContain('workshop');
    expect(result.injectionText).toContain('Temporal evidence candidates:');
  });
});

describe('computePackagingSignal', () => {
  it('returns zeros for empty input', () => {
    const signal = computePackagingSignal([]);
    expect(signal).toEqual({
      reordered: false,
      episodeCount: 0,
      answerBearingCount: 0,
      contextCount: 0,
      reorderDistance: 0,
    });
  });

  it('detects no reorder when score order matches session-priority order', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9, content: 'plain fact' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.reordered).toBe(false);
    expect(signal.reorderDistance).toBe(0);
  });

  it('counts distinct episodes', () => {
    const memories = [
      makeResult({ id: 'a', episode_id: 'ep-1' }),
      makeResult({ id: 'b', episode_id: 'ep-1' }),
      makeResult({ id: 'c', episode_id: 'ep-2' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.episodeCount).toBe(2);
  });

  it('counts answer-bearing vs context memories', () => {
    const memories = [
      makeResult({ id: 'a', content: 'The answer is 42.' }),
      makeResult({ id: 'b', content: 'Some background context about the topic' }),
    ];
    const signal = computePackagingSignal(memories);
    expect(signal.answerBearingCount + signal.contextCount).toBe(2);
  });

  it('computes nonzero Kendall tau when packaging reorders', () => {
    const memories = [
      makeResult({ id: 'a', score: 0.9, episode_id: 'ep-1', content: 'context' }),
      makeResult({ id: 'b', score: 0.5, episode_id: 'ep-2', content: 'The answer is yes.' }),
    ];
    const signal = computePackagingSignal(memories);
    if (signal.reordered) {
      expect(signal.reorderDistance).toBeGreaterThan(0);
    }
  });
});

describe('packagingUseObservedAt', () => {
  const created = new Date('2026-04-01T12:00:00Z');
  const observedA = new Date('2026-03-15T09:00:00Z');
  const observedB = new Date('2026-03-20T09:00:00Z');

  it('uses created_at by default', () => {
    mockConfig.packagingUseObservedAt = false;
    const memories = [
      makeResult({ id: 'a', content: 'first observed', created_at: created, observed_at: observedB }),
      makeResult({ id: 'b', content: 'second observed', created_at: created, observed_at: observedA }),
    ];
    const out = formatSimpleInjection(memories);
    expect(out).toContain('[2026-04-01]');
    expect(out).not.toContain('[2026-03-15]');
  });

  it('surfaces observed_at dates in output when flag is on', () => {
    mockConfig.packagingUseObservedAt = true;
    const memories = [
      makeResult({ id: 'a', content: 'later observed', created_at: created, observed_at: observedB }),
      makeResult({ id: 'b', content: 'earlier observed', created_at: created, observed_at: observedA }),
    ];
    const out = formatSimpleInjection(memories);
    expect(out).toContain('[2026-03-15]');
    expect(out).toContain('[2026-03-20]');
    expect(out).not.toContain('[2026-04-01]');
    mockConfig.packagingUseObservedAt = false;
  });

  it('sorts chronologically by observed_at in xml injection when flag is on', () => {
    mockConfig.packagingUseObservedAt = true;
    const memories = [
      makeResult({ id: 'a', content: 'later observed', created_at: created, observed_at: observedB }),
      makeResult({ id: 'b', content: 'earlier observed', created_at: created, observed_at: observedA }),
    ];
    const out = formatInjection(memories);
    const idxEarlier = out.indexOf('earlier observed');
    const idxLater = out.indexOf('later observed');
    expect(idxEarlier).toBeGreaterThanOrEqual(0);
    expect(idxLater).toBeGreaterThanOrEqual(0);
    expect(idxEarlier).toBeLessThan(idxLater);
    mockConfig.packagingUseObservedAt = false;
  });

  it('falls back to created_at when observed_at is missing', () => {
    mockConfig.packagingUseObservedAt = true;
    const memories = [
      makeResult({ id: 'a', content: 'no observed', created_at: created, observed_at: undefined as unknown as Date }),
    ];
    const out = formatSimpleInjection(memories);
    expect(out).toContain('[2026-04-01]');
    mockConfig.packagingUseObservedAt = false;
  });
});

describe('packagingDualDate', () => {
  const created = new Date('2026-04-01T12:00:00Z');
  const observed = new Date('2024-03-15T09:00:00Z');

  it('does not emit observed_at by default', () => {
    mockConfig.packagingDualDate = false;
    const memories = [makeResult({ id: 'a', created_at: created, observed_at: observed })];
    const out = formatInjection(memories);
    expect(out).not.toContain('observed_at=');
  });

  it('emits observed_at when flag is on and dates differ', () => {
    mockConfig.packagingDualDate = true;
    const memories = [makeResult({ id: 'a', created_at: created, observed_at: observed })];
    const out = formatInjection(memories);
    expect(out).toContain('created_at="2026-04-01T12:00:00.000Z"');
    expect(out).toContain('observed_at="2024-03-15T09:00:00.000Z"');
    mockConfig.packagingDualDate = false;
  });

  it('omits observed_at when dates are identical', () => {
    mockConfig.packagingDualDate = true;
    const memories = [makeResult({ id: 'a', created_at: created, observed_at: created })];
    const out = formatInjection(memories);
    expect(out).not.toContain('observed_at=');
    mockConfig.packagingDualDate = false;
  });

  it('omits observed_at when memory has no observed_at', () => {
    mockConfig.packagingDualDate = true;
    const memories = [makeResult({ id: 'a', created_at: created, observed_at: undefined as unknown as Date })];
    const out = formatInjection(memories);
    expect(out).not.toContain('observed_at=');
    mockConfig.packagingDualDate = false;
  });
});

describe('timelineChannelEnabled', () => {
  it('does not emit ## TIMELINE by default', () => {
    mockConfig.timelineChannelEnabled = false;
    const memories = [
      makeResult({ id: 'a', observed_at: new Date('2024-03-15T09:00:00Z') }),
      makeResult({ id: 'b', observed_at: new Date('2024-04-10T09:00:00Z') }),
    ];
    const out = formatInjection(memories);
    expect(out).not.toContain('## TIMELINE');
  });

  it('emits ## TIMELINE with sorted unique dates when flag is on', () => {
    mockConfig.timelineChannelEnabled = true;
    const memories = [
      makeResult({ id: 'a', observed_at: new Date('2024-04-10T09:00:00Z'), content: 'b' }),
      makeResult({ id: 'b', observed_at: new Date('2024-03-15T09:00:00Z'), content: 'a' }),
      makeResult({ id: 'c', observed_at: new Date('2024-03-15T11:00:00Z'), content: 'c' }),
    ];
    const out = formatInjection(memories);
    expect(out).toContain('## TIMELINE');
    const tl = out.slice(out.indexOf('## TIMELINE'));
    const idxEarly = tl.indexOf('2024-03-15');
    const idxLate = tl.indexOf('2024-04-10');
    expect(idxEarly).toBeGreaterThanOrEqual(0);
    expect(idxLate).toBeGreaterThan(idxEarly);
    expect((tl.match(/2024-03-15/g) ?? []).length).toBe(1);
    mockConfig.timelineChannelEnabled = false;
  });

  it('omits ## TIMELINE when no memory has observed_at', () => {
    mockConfig.timelineChannelEnabled = true;
    const memories = [makeResult({ id: 'a', observed_at: undefined as unknown as Date })];
    const out = formatInjection(memories);
    expect(out).not.toContain('## TIMELINE');
    mockConfig.timelineChannelEnabled = false;
  });
});

describe('entityFacts channel', () => {
  it('does not emit ## FACTS when entityFacts is empty', () => {
    const memories = [makeResult({ id: 'a' })];
    const out = formatInjection(memories, { entityFacts: [] });
    expect(out).not.toContain('## FACTS');
  });

  it('emits ## FACTS when triples are present', () => {
    const memories = [makeResult({ id: 'a' })];
    const out = formatInjection(memories, {
      entityFacts: [
        { entity: 'problems', attribute: 'count', value: '25', observedAt: new Date('2024-04-01T00:00:00Z') },
        { entity: 'app', attribute: 'features', value: 'A,B,C', observedAt: new Date('2024-04-10T00:00:00Z') },
      ],
    });
    expect(out).toContain('## FACTS');
    expect(out).toContain('problems.count = 25');
    expect(out).toContain('app.features = A,B,C');
  });
});

describe('episodesChannelEnabled', () => {
  it('prepends ## EPISODES block above the memories body when episodes are passed', () => {
    const memories = [makeResult({ id: 'a', content: 'atomic fact A' })];
    const episodes = [
      { topic: 'morning-routine', narrative: 'Caroline runs at 6am.' },
      { topic: 'work-prefs', narrative: 'Caroline prefers async standups.' },
    ];
    const out = formatInjection(memories, { episodes });
    expect(out).toContain('## EPISODES');
    expect(out).toContain('### Episode 1: morning-routine');
    expect(out).toContain('Caroline runs at 6am.');
    expect(out).toContain('### Episode 2: work-prefs');
    expect(out).toContain('Caroline prefers async standups.');
    const idxEpisodes = out.indexOf('## EPISODES');
    const idxBody = out.indexOf('<atomicmem_context');
    expect(idxEpisodes).toBeLessThan(idxBody);
  });

  it('renders ## EPISODES even when memories array is empty', () => {
    const episodes = [{ topic: 'travel', narrative: 'Caroline visited Lisbon.' }];
    const out = formatInjection([], { episodes });
    expect(out).toContain('## EPISODES');
    expect(out).toContain('### Episode 1: travel');
    expect(out).toContain('Caroline visited Lisbon.');
  });
});

describe('buildInjection — L1 format-hint wiring', () => {
  it('returns injection unchanged when answerFormatAlignmentEnabled is false (default)', () => {
    mockConfig.answerFormatAlignmentEnabled = false;
    const mem = makeResult({ content: 'Alice prefers tea.' });
    const { injectionText } = buildInjection([mem], 'What does Alice prefer?', 'flat');
    expect(injectionText).not.toContain('FORMAT:');
  });

  it('prepends FORMAT hint when answerFormatAlignmentEnabled is true and query is ordered-list-shaped', () => {
    mockConfig.answerFormatAlignmentEnabled = true;
    const mem = makeResult({ content: 'Step one: install. Step two: run.' });
    // Pass ORDERED_LIST explicitly — OTHER no longer applies the hint
    // (per the per-question-type packaging rule).
    const { injectionText } = buildInjection(
      [mem], 'List five steps in order', 'flat',
      undefined, undefined, undefined, undefined, undefined, undefined,
      QuestionType.ORDERED_LIST,
    );
    expect(injectionText).toContain('FORMAT:');
    mockConfig.answerFormatAlignmentEnabled = false;
  });
});

function sampleReflection(text: string, type: Reflection['observationType'] = 'event_summary'): Reflection {
  return {
    id: 'r1',
    userId: 'u',
    conversationId: 'c',
    observation: text,
    observationType: type,
    evidenceMemoryIds: ['m1', 'm2'],
    embedding: [],
    createdAt: new Date(),
  };
}

describe('buildInjection — reflections channel', () => {
  it('emits ## OBSERVATIONS section when reflections array is non-empty (SUMMARY type)', () => {
    const mem = makeResult({ content: 'Alice prefers tea.' });
    const reflections = [sampleReflection('Observation 1')];
    // OBSERVATIONS now only emits for CONTRADICTION/SUMMARY types,
    // not for OTHER. Pass SUMMARY explicitly to exercise the channel.
    const { injectionText } = buildInjection(
      [mem], 'Give me a comprehensive summary.', 'flat',
      undefined, undefined, undefined, undefined, undefined, reflections,
      QuestionType.SUMMARY,
    );
    expect(injectionText).toContain('## OBSERVATIONS');
    expect(injectionText).toContain('Observation 1');
    expect(injectionText).toContain('event_summary');
    expect(injectionText).toContain('m1, m2');
  });

  it('omits the OBSERVATIONS section when reflections array is empty', () => {
    const mem = makeResult({ content: 'Alice prefers tea.' });
    const { injectionText } = buildInjection(
      [mem], 'What does Alice prefer?', 'flat',
      undefined, undefined, undefined, undefined, undefined, [],
    );
    expect(injectionText).not.toContain('## OBSERVATIONS');
  });

  it('omits the OBSERVATIONS section when reflections parameter is undefined', () => {
    const mem = makeResult({ content: 'Alice prefers tea.' });
    const { injectionText } = buildInjection([mem], 'What does Alice prefer?', 'flat');
    expect(injectionText).not.toContain('## OBSERVATIONS');
  });
});

import { QuestionType } from '../answer-format.js';
import type { EventChain } from '../event-chain-detector.js';

/** Minimal EventChain fixture with three dated members. */
function sampleChain(): EventChain {
  return {
    entity: 'Project X',
    score: 9,
    members: [
      { memoryId: 'm1', observedAt: new Date('2026-01-01'), text: 'Step one' },
      { memoryId: 'm2', observedAt: new Date('2026-01-02'), text: 'Step two' },
      { memoryId: 'm3', observedAt: new Date('2026-01-03'), text: 'Step three' },
    ],
  };
}

describe('buildInjection — question-type-gated channels', () => {
  const mem = makeResult({ content: 'There were 5 meetings.' });
  const reflections = [sampleReflection('Obs A')];
  const chains = [sampleChain()];

  beforeEach(() => {
    mockConfig.eventChainPackagingEnabled = true;
    mockConfig.answerFormatAlignmentEnabled = false;
  });

  afterEach(() => {
    mockConfig.eventChainPackagingEnabled = false;
    mockConfig.answerFormatAlignmentEnabled = false;
  });

  it('NUMERIC_COUNT suppresses EVENT_CHAIN and OBSERVATIONS', () => {
    const { injectionText } = buildInjection(
      [mem], 'How many meetings?', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.NUMERIC_COUNT,
    );
    expect(injectionText).not.toContain('## EVENT_CHAIN');
    expect(injectionText).not.toContain('## OBSERVATIONS');
  });

  it('EXACT_DATE suppresses EVENT_CHAIN and OBSERVATIONS', () => {
    const { injectionText } = buildInjection(
      [mem], 'When did the sprint start?', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.EXACT_DATE,
    );
    expect(injectionText).not.toContain('## EVENT_CHAIN');
    expect(injectionText).not.toContain('## OBSERVATIONS');
  });

  it('ORDERED_LIST emits EVENT_CHAIN but not OBSERVATIONS', () => {
    const { injectionText } = buildInjection(
      [mem], 'List 3 steps in order', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.ORDERED_LIST,
    );
    expect(injectionText).toContain('## EVENT_CHAIN');
    expect(injectionText).not.toContain('## OBSERVATIONS');
  });

  it('SUMMARY emits OBSERVATIONS but not EVENT_CHAIN', () => {
    const { injectionText } = buildInjection(
      [mem], 'Summarize the project', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.SUMMARY,
    );
    expect(injectionText).toContain('## OBSERVATIONS');
    expect(injectionText).not.toContain('## EVENT_CHAIN');
  });

  it('CONTRADICTION emits OBSERVATIONS but not EVENT_CHAIN', () => {
    const { injectionText } = buildInjection(
      [mem], 'Have I ever contradicted myself?', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.CONTRADICTION,
    );
    expect(injectionText).toContain('## OBSERVATIONS');
    expect(injectionText).not.toContain('## EVENT_CHAIN');
  });

  it('OTHER suppresses all auxiliary channels (channels were causing IF/KU/IE collapse)', () => {
    const { injectionText } = buildInjection(
      [mem], 'Tell me about Project X', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
      QuestionType.OTHER,
    );
    // Smoke v1/v2 evidence: emitting EVENT_CHAIN/OBSERVATIONS for OTHER
    // queries paraphrased content above raw facts and confused Haiku.
    // OTHER now gets a clean raw-context prompt.
    expect(injectionText).not.toContain('## EVENT_CHAIN');
    expect(injectionText).not.toContain('## OBSERVATIONS');
    expect(injectionText).not.toContain('## TIMELINE');
  });

  it('PREFERENCE suppresses FORMAT hint even when answerFormatAlignmentEnabled', () => {
    mockConfig.answerFormatAlignmentEnabled = true;
    const { injectionText } = buildInjection(
      [mem], 'What would you suggest?', 'flat',
      undefined, undefined, undefined, undefined, undefined, undefined,
      QuestionType.PREFERENCE,
    );
    expect(injectionText).not.toContain('FORMAT:');
  });

  it('defaults to OTHER behavior when questionType is omitted (no auxiliary channels)', () => {
    const { injectionText } = buildInjection(
      [mem], 'Any context?', 'flat',
      undefined, undefined, undefined, undefined, chains, reflections,
    );
    expect(injectionText).not.toContain('## EVENT_CHAIN');
    expect(injectionText).not.toContain('## OBSERVATIONS');
    expect(injectionText).not.toContain('## TIMELINE');
  });
});
