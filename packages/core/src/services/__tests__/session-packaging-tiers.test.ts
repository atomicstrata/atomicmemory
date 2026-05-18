/**
 * Tests for within-session three-tier ordering in session-packaging.ts.
 *
 * Covers withinSessionTier() classification and the three-tier integration
 * through sortBySessionPriority(). Split from session-packaging.test.ts
 * to stay within the 400-line limit.
 */

import { describe, it, expect } from 'vitest';
import {
  withinSessionTier,
  sortBySessionPriority,
} from '../session-packaging.js';
import { createSessionTestMemory, resetSessionMemoryCounter } from './test-fixtures.js';

resetSessionMemoryCounter(1000);

function makeMemory(overrides: { content: string; episode_id?: string | null; created_at?: Date }) {
  return createSessionTestMemory('tier-mem', overrides);
}

describe('withinSessionTier', () => {
  it('assigns tier 1 to amounts, dates, counts, outcomes', () => {
    expect(withinSessionTier('User paid $500 for the workshop')).toBe(1);
    expect(withinSessionTier('The project took 3 months')).toBe(1);
    expect(withinSessionTier('User visited the gym 3 times')).toBe(1);
    expect(withinSessionTier('Team has 15 members')).toBe(1);
    expect(withinSessionTier('User scored 170 on GRE')).toBe(1);
    expect(withinSessionTier('User accepted the internship')).toBe(1);
    expect(withinSessionTier('Moved to Berlin in 2023')).toBe(1);
  });

  it('assigns tier 2 to participants, locations, state transitions', () => {
    expect(withinSessionTier('User attended the Berlin conference')).toBe(2);
    expect(withinSessionTier('Dr. Smith presented the keynote')).toBe(2);
    expect(withinSessionTier('User works at Stanford')).toBe(2);
    expect(withinSessionTier('User switched from Vim to VS Code')).toBe(2);
  });

  it('assigns tier 3 to advisory and neutral content', () => {
    expect(withinSessionTier('Assistant recommended trying meditation')).toBe(3);
    expect(withinSessionTier('User plans to learn Python someday')).toBe(3);
    expect(withinSessionTier('The project uses TypeScript')).toBe(3);
    expect(withinSessionTier('Consider using a linter')).toBe(3);
  });

  it('prefers tier 1 when both direct-answer and supporting signals exist', () => {
    expect(withinSessionTier('User attended 5 sessions of therapy')).toBe(1);
    expect(withinSessionTier('Dr. Smith charged $200 per session')).toBe(1);
  });
});

describe('sortBySessionPriority — three-tier integration', () => {
  it('orders within-session: amount > participant > advisory', () => {
    const amount = makeMemory({
      content: 'User paid $500 for the workshop',
      episode_id: 'session-X',
      created_at: new Date('2023-03-01'),
    });
    const participant = makeMemory({
      content: 'Dr. Smith led the workshop',
      episode_id: 'session-X',
      created_at: new Date('2023-03-01'),
    });
    const advisory = makeMemory({
      content: 'Assistant recommended taking more workshops',
      episode_id: 'session-X',
      created_at: new Date('2023-03-01'),
    });
    const otherSession = makeMemory({
      content: 'User visited the office in 2022',
      episode_id: 'session-Y',
      created_at: new Date('2023-01-01'),
    });

    const result = sortBySessionPriority([advisory, participant, amount, otherSession]);
    const sessionXResults = result.filter((m) => m.episode_id === 'session-X');
    expect(sessionXResults[0].id).toBe(amount.id);
    expect(sessionXResults[1].id).toBe(participant.id);
    expect(sessionXResults[2].id).toBe(advisory.id);
  });

  it('orders event-outcome before generic networking summary', () => {
    const outcome = makeMemory({
      content: 'User accepted the internship offer',
      episode_id: 'session-A',
      created_at: new Date('2023-04-01'),
    });
    const networkingSummary = makeMemory({
      content: 'User discussed career options with mentor',
      episode_id: 'session-A',
      created_at: new Date('2023-04-01'),
    });
    const recommendation = makeMemory({
      content: 'Assistant recommended updating the resume',
      episode_id: 'session-A',
      created_at: new Date('2023-04-01'),
    });
    const otherSession = makeMemory({
      content: 'User attended a workshop in January 15',
      episode_id: 'session-B',
      created_at: new Date('2023-01-15'),
    });

    const result = sortBySessionPriority([recommendation, networkingSummary, outcome, otherSession]);
    const sessionAResults = result.filter((m) => m.episode_id === 'session-A');
    expect(sessionAResults[0].id).toBe(outcome.id);
  });

  it('preserves cross-session chronological order with three-tier reordering within', () => {
    const earlyAdvisory = makeMemory({
      content: 'User plans to learn Python someday',
      episode_id: 'early-session',
      created_at: new Date('2023-01-10'),
    });
    const earlyAmount = makeMemory({
      content: 'User paid $100 for the course',
      episode_id: 'early-session',
      created_at: new Date('2023-01-11'),
    });
    const lateParticipant = makeMemory({
      content: 'Dr. Jones presented the findings',
      episode_id: 'late-session',
      created_at: new Date('2023-06-01'),
    });
    const lateAmount = makeMemory({
      content: 'Conference fee was €300',
      episode_id: 'late-session',
      created_at: new Date('2023-06-02'),
    });

    const result = sortBySessionPriority([lateParticipant, earlyAdvisory, lateAmount, earlyAmount]);
    expect(result[0].id).toBe(earlyAmount.id);
    expect(result[1].id).toBe(earlyAdvisory.id);
    expect(result[2].id).toBe(lateAmount.id);
    expect(result[3].id).toBe(lateParticipant.id);
  });
});
