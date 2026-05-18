/**
 * Unit tests for session-packaging.ts.
 *
 * Tests answer-bearing detection and multi-session reordering policy
 * without any DB or LLM dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  isAnswerBearing,
  isAdvisoryOnly,
  trimToAnswerBearingBudget,
  sortBySessionPriority,
} from '../session-packaging.js';
import { createSessionTestMemory, resetSessionMemoryCounter } from './test-fixtures.js';

/* ---------- helpers ---------- */

resetSessionMemoryCounter(0);

function makeMemory(overrides: { content: string; episode_id?: string | null; created_at?: Date }) {
  return createSessionTestMemory('mem', overrides);
}

/* ---------- isAnswerBearing ---------- */

describe('isAnswerBearing', () => {
  it('detects currency amounts', () => {
    expect(isAnswerBearing('User paid $500 for the workshop')).toBe(true);
    expect(isAnswerBearing('The budget was €200 per month')).toBe(true);
    expect(isAnswerBearing('Salary is 80000 dollars')).toBe(true);
  });

  it('detects durations', () => {
    expect(isAnswerBearing('The project took 3 months to complete')).toBe(true);
    expect(isAnswerBearing('Deadline is in 2 weeks')).toBe(true);
    expect(isAnswerBearing('User spent 5 hours debugging')).toBe(true);
  });

  it('detects named dates', () => {
    expect(isAnswerBearing('Meeting scheduled for January 15')).toBe(true);
    expect(isAnswerBearing('Conference starts March 3')).toBe(true);
  });

  it('detects past-attendance language', () => {
    expect(isAnswerBearing('User attended the Berlin conference')).toBe(true);
    expect(isAnswerBearing('She visited the Tokyo office last week')).toBe(true);
    expect(isAnswerBearing('User graduated from MIT')).toBe(true);
    expect(isAnswerBearing('They traveled to Paris for the summit')).toBe(true);
  });

  it('detects named participants (multi-word proper nouns)', () => {
    expect(isAnswerBearing('Dr. Smith presented the keynote')).toBe(true);
    expect(isAnswerBearing('John Carter led the workshop')).toBe(true);
    expect(isAnswerBearing('Miss Bee Providore serves Indonesian cuisine')).toBe(true);
  });

  it('detects year references', () => {
    expect(isAnswerBearing('User has been coding since 2019')).toBe(true);
    expect(isAnswerBearing('Moved to Berlin in 2023')).toBe(true);
  });

  it('detects quantity patterns', () => {
    expect(isAnswerBearing('Team has 15 members')).toBe(true);
    expect(isAnswerBearing('Conference had 200 attendees')).toBe(true);
  });

  it('rejects generic advisory content', () => {
    expect(isAnswerBearing('Consider using a linter for code quality')).toBe(false);
    expect(isAnswerBearing('It is recommended to write tests')).toBe(false);
    expect(isAnswerBearing('Good practice to keep functions small')).toBe(false);
  });

  it('rejects vague suggestions without specifics', () => {
    expect(isAnswerBearing('Try exploring different options')).toBe(false);
    expect(isAnswerBearing('You might want to reconsider the approach')).toBe(false);
  });

  it('detects explicit counts', () => {
    expect(isAnswerBearing('User visited the gym 3 times this week')).toBe(true);
    expect(isAnswerBearing('Attended 5 sessions of therapy')).toBe(true);
    expect(isAnswerBearing('Happened on 2 occasions')).toBe(true);
  });

  it('detects location specificity', () => {
    expect(isAnswerBearing('User works at Stanford')).toBe(true);
    expect(isAnswerBearing('User lives in San Francisco')).toBe(true);
    expect(isAnswerBearing('Moved from New York')).toBe(true);
  });

  it('detects state transitions', () => {
    expect(isAnswerBearing('User switched from Vim to VS Code')).toBe(true);
    expect(isAnswerBearing('Team migrated from MySQL to PostgreSQL')).toBe(true);
    expect(isAnswerBearing('Changed to a new provider')).toBe(true);
  });

  it('detects comparative/scored results', () => {
    expect(isAnswerBearing('User scored 170 on GRE quant')).toBe(true);
    expect(isAnswerBearing('The restaurant is rated 4 stars')).toBe(true);
    expect(isAnswerBearing('User earned 95 on the final exam')).toBe(true);
  });

  it('detects event outcomes', () => {
    expect(isAnswerBearing('User accepted the internship at Google')).toBe(true);
    expect(isAnswerBearing('The project was completed ahead of schedule')).toBe(true);
    expect(isAnswerBearing('User passed the certification exam')).toBe(true);
    expect(isAnswerBearing('Team launched the product in March')).toBe(true);
    expect(isAnswerBearing('User submitted the application on Friday')).toBe(true);
  });
});

/* ---------- isAdvisoryOnly ---------- */

describe('isAdvisoryOnly', () => {
  it('detects pure advisory content', () => {
    expect(isAdvisoryOnly('Assistant recommended trying meditation')).toBe(true);
    expect(isAdvisoryOnly('User plans to learn Python someday')).toBe(true);
    expect(isAdvisoryOnly('User discussed career options with mentor')).toBe(true);
  });

  it('returns false when answer-bearing signals are present', () => {
    expect(isAdvisoryOnly('User plans to start in January 15')).toBe(false);
    expect(isAdvisoryOnly('Assistant recommended Dr. Smith for therapy')).toBe(false);
    expect(isAdvisoryOnly('User discussed the $500 workshop fee')).toBe(false);
  });

  it('returns false for neutral content (neither advisory nor answer-bearing)', () => {
    expect(isAdvisoryOnly('User prefers dark mode')).toBe(false);
    expect(isAdvisoryOnly('The project uses TypeScript')).toBe(false);
  });
});

/* ---------- trimToAnswerBearingBudget ---------- */

describe('trimToAnswerBearingBudget', () => {
  it('returns all memories when within budget', () => {
    const m1 = makeMemory({ content: 'User paid $100', episode_id: 'ep-1' });
    const m2 = makeMemory({ content: 'Generic advice', episode_id: 'ep-2' });
    const result = trimToAnswerBearingBudget([m1, m2], 5);
    expect(result).toHaveLength(2);
  });

  it('keeps answer-bearing and drops advisory when over budget', () => {
    const ab = makeMemory({ content: 'User paid $500 for workshop', episode_id: 'ep-1' });
    const adv1 = makeMemory({ content: 'Good practice to write tests', episode_id: 'ep-2' });
    const adv2 = makeMemory({ content: 'Consider using linting tools', episode_id: 'ep-3' });
    const result = trimToAnswerBearingBudget([adv1, ab, adv2], 2);
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.id === ab.id)).toBe(true);
  });

  it('handles all answer-bearing with tight budget', () => {
    const ab1 = makeMemory({ content: 'User paid $100', episode_id: 'ep-1' });
    const ab2 = makeMemory({ content: 'User scored 95 on exam', episode_id: 'ep-2' });
    const ab3 = makeMemory({ content: 'User attended 3 sessions', episode_id: 'ep-3' });
    const result = trimToAnswerBearingBudget([ab1, ab2, ab3], 2);
    expect(result).toHaveLength(2);
  });

  it('handles all advisory with tight budget', () => {
    const adv1 = makeMemory({ content: 'Try exploring options', episode_id: 'ep-1' });
    const adv2 = makeMemory({ content: 'Good to keep learning', episode_id: 'ep-2' });
    const result = trimToAnswerBearingBudget([adv1, adv2], 1);
    expect(result).toHaveLength(1);
  });

  it('returns empty for empty input', () => {
    expect(trimToAnswerBearingBudget([], 5)).toEqual([]);
  });
});

/* ---------- sortBySessionPriority ---------- */

describe('sortBySessionPriority', () => {
  it('returns empty array unchanged', () => {
    expect(sortBySessionPriority([])).toEqual([]);
  });

  it('returns single-item array unchanged', () => {
    const m = makeMemory({ content: 'solo fact' });
    const result = sortBySessionPriority([m]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(m.id);
  });

  it('falls back to chronological for single session', () => {
    const early = makeMemory({
      content: 'Generic advice about testing',
      episode_id: 'ep-1',
      created_at: new Date('2023-01-10'),
    });
    const late = makeMemory({
      content: 'More generic advice',
      episode_id: 'ep-1',
      created_at: new Date('2023-01-20'),
    });
    const result = sortBySessionPriority([late, early]);
    expect(result[0].id).toBe(early.id);
    expect(result[1].id).toBe(late.id);
  });

  it('groups by session and promotes answer-bearing within each', () => {
    const s1Advisory = makeMemory({
      content: 'The workshop was a great learning experience',
      episode_id: 'session-1',
      created_at: new Date('2023-01-15'),
    });
    const s1AnswerBearing = makeMemory({
      content: 'User paid $500 for the Python workshop',
      episode_id: 'session-1',
      created_at: new Date('2023-01-15'),
    });
    const s2Advisory = makeMemory({
      content: 'Conferences are great for networking',
      episode_id: 'session-2',
      created_at: new Date('2023-02-10'),
    });
    const s2AnswerBearing = makeMemory({
      content: 'User attended the Berlin conference with Dr. Smith',
      episode_id: 'session-2',
      created_at: new Date('2023-02-10'),
    });

    const result = sortBySessionPriority([
      s1Advisory, s2Advisory, s2AnswerBearing, s1AnswerBearing,
    ]);

    expect(result[0].id).toBe(s1AnswerBearing.id);
    expect(result[1].id).toBe(s1Advisory.id);
    expect(result[2].id).toBe(s2AnswerBearing.id);
    expect(result[3].id).toBe(s2Advisory.id);
  });

  it('orders session groups chronologically by earliest memory', () => {
    const s2Mem = makeMemory({
      content: 'User paid €200 for flight',
      episode_id: 'later-session',
      created_at: new Date('2023-06-01'),
    });
    const s1Mem = makeMemory({
      content: 'User attended the kickoff meeting',
      episode_id: 'earlier-session',
      created_at: new Date('2023-01-01'),
    });

    const result = sortBySessionPriority([s2Mem, s1Mem]);
    expect(result[0].id).toBe(s1Mem.id);
    expect(result[1].id).toBe(s2Mem.id);
  });

  it('preserves chronological order within answer-bearing tier', () => {
    const ab1 = makeMemory({
      content: 'User paid $100 in January',
      episode_id: 'ep-A',
      created_at: new Date('2023-01-05'),
    });
    const ab2 = makeMemory({
      content: 'User paid $200 in February',
      episode_id: 'ep-A',
      created_at: new Date('2023-02-05'),
    });
    const adv = makeMemory({
      content: 'Good advice about budgeting',
      episode_id: 'ep-B',
      created_at: new Date('2023-03-01'),
    });

    const result = sortBySessionPriority([adv, ab2, ab1]);
    expect(result[0].id).toBe(ab1.id);
    expect(result[1].id).toBe(ab2.id);
    expect(result[2].id).toBe(adv.id);
  });

  it('handles null episode_id by grouping into shared bucket', () => {
    const withEp = makeMemory({
      content: 'User attended workshop in 2023',
      episode_id: 'ep-1',
      created_at: new Date('2023-01-15'),
    });
    const noEp1 = makeMemory({
      content: 'Some advisory content',
      episode_id: null,
      created_at: new Date('2023-02-01'),
    });
    const noEp2 = makeMemory({
      content: 'User paid $50 for book',
      episode_id: null,
      created_at: new Date('2023-02-02'),
    });

    const result = sortBySessionPriority([noEp1, noEp2, withEp]);
    expect(result[0].id).toBe(withEp.id);
    expect(result[1].id).toBe(noEp2.id);
    expect(result[2].id).toBe(noEp1.id);
  });

  it('does not mutate the input array', () => {
    const m1 = makeMemory({
      content: 'User paid $100',
      episode_id: 'ep-1',
      created_at: new Date('2023-01-01'),
    });
    const m2 = makeMemory({
      content: 'Generic advice',
      episode_id: 'ep-2',
      created_at: new Date('2023-02-01'),
    });
    const input = [m2, m1];
    const inputCopy = [...input];
    sortBySessionPriority(input);
    expect(input.map((m) => m.id)).toEqual(inputCopy.map((m) => m.id));
  });

});
