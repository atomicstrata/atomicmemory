/**
 * Unit tests for TR (Temporal Reasoning) specialist — deterministic path.
 *
 * No LLM calls, no Postgres, no API keys required.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldInvokeTrSpecialist,
  runTrSpecialist,
  extractDatesFromText,
} from '../tr-specialist.js';

describe('shouldInvokeTrSpecialist', () => {
  it('matches "how many days/weeks/months between"', () => {
    expect(shouldInvokeTrSpecialist('How many days between X and Y?')).toBe(true);
    expect(shouldInvokeTrSpecialist('How many weeks do I have between X and Y?')).toBe(true);
  });
  it('matches "how long between/since/until"', () => {
    expect(shouldInvokeTrSpecialist('How long between X and Y?')).toBe(true);
    expect(shouldInvokeTrSpecialist('How long since the last release?')).toBe(true);
  });
  it('does NOT match non-temporal questions', () => {
    expect(shouldInvokeTrSpecialist('How many features did I add?')).toBe(false);
    expect(shouldInvokeTrSpecialist('What is the deadline?')).toBe(false);
  });
});

describe('extractDatesFromText', () => {
  it('extracts ISO dates', () => {
    const dates = extractDatesFromText('Started 2024-03-29 and ended 2024-04-19.');
    expect(dates).toHaveLength(2);
    expect(dates[0].toISOString().slice(0, 10)).toBe('2024-03-29');
    expect(dates[1].toISOString().slice(0, 10)).toBe('2024-04-19');
  });
  it('extracts "Month Day, Year" forms with default year', () => {
    const dates = extractDatesFromText('I got the key on March 10 and finished March 12.', 2024);
    expect(dates).toHaveLength(2);
    expect(dates[0].toISOString().slice(0, 10)).toBe('2024-03-10');
    expect(dates[1].toISOString().slice(0, 10)).toBe('2024-03-12');
  });
});

describe('runTrSpecialist — deterministic', () => {
  it('returns handled=false when query does not match', async () => {
    const result = await runTrSpecialist({
      memories: [{ id: 'm1', text: 'foo' }],
      query: 'How many features did I add?',
    });
    expect(result.handled).toBe(false);
    expect(result.usedLlm).toBe(false);
  });

  it('returns no answer when memories are empty', async () => {
    const result = await runTrSpecialist({
      memories: [],
      query: 'How many days between A and B?',
    });
    expect(result.handled).toBe(true);
    expect(result.answer).toBe('');
  });

  it('computes duration using ISO dates from memory text', async () => {
    const result = await runTrSpecialist({
      memories: [
        { id: 'm1', text: 'sprint 1 ends 2024-03-29' },
        { id: 'm2', text: 'analytics deadline 2024-04-19' },
      ],
      query: 'How many days were there between sprint 1 end and the analytics deadline?',
    });
    expect(result.handled).toBe(true);
    expect(result.durationDays).toBe(21);
    expect(result.answer).toContain('21 days');
  });

  it('uses observed_at when memory text has no date', async () => {
    const result = await runTrSpecialist({
      memories: [
        { id: 'm1', text: 'sprint 1 ends', observedAt: new Date('2024-03-29T00:00:00Z') },
        { id: 'm2', text: 'analytics deadline', observedAt: new Date('2024-04-19T00:00:00Z') },
      ],
      query: 'How many days between sprint 1 end and the analytics deadline?',
    });
    expect(result.handled).toBe(true);
    expect(result.durationDays).toBe(21);
  });

  it('formats as weeks when the query asks for weeks', async () => {
    const result = await runTrSpecialist({
      memories: [
        { id: 'm1', text: 'transaction features done 2024-01-15' },
        { id: 'm2', text: 'final deployment 2024-03-15' },
      ],
      query: 'How many weeks between transaction features and final deployment?',
    });
    expect(result.handled).toBe(true);
    expect(result.durationDays).toBe(60);
    expect(result.answer).toContain('9 weeks');
  });

  it('never sets usedLlm=true (deterministic path only)', async () => {
    const result = await runTrSpecialist({
      memories: [{ id: 'm1', text: 'foo 2024-03-10' }, { id: 'm2', text: 'bar 2024-03-12' }],
      query: 'How many days between foo and bar?',
    });
    expect(result.usedLlm).toBe(false);
  });
});
