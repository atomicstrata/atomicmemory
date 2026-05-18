/**
 * Unit tests for the MSR (Multi-Session Reasoning) query detector.
 * Pure regex classifier — no DB, no LLM, no async.
 */

import { describe, expect, it } from 'vitest';
import { isMsrQuery } from '../msr-detector.js';

describe('isMsrQuery — MSR triggers (positive cases)', () => {
  it('matches "across my sessions"', () => {
    expect(
      isMsrQuery(
        'How many different user roles and security features am I trying to implement across my sessions?',
      ),
    ).toBe(true);
  });

  it('matches "across my <thing> conversations"', () => {
    expect(
      isMsrQuery(
        'How many different features or concerns did I mention wanting to handle across my weather app conversations?',
      ),
    ).toBe(true);
  });

  it('matches "across all my chats"', () => {
    expect(isMsrQuery('What different topics have I discussed across all my chats?')).toBe(true);
  });

  it('matches "throughout all my conversations"', () => {
    expect(isMsrQuery('Throughout all my conversations, what frameworks have I considered?')).toBe(
      true,
    );
  });

  it('matches "different X I mentioned"', () => {
    expect(
      isMsrQuery('List the different libraries I mentioned wanting to try over the past month.'),
    ).toBe(true);
  });
});

describe('isMsrQuery — non-MSR question types (negative cases)', () => {
  it('does NOT match KU (knowledge update / latest state)', () => {
    expect(isMsrQuery("What's the latest version of my dashboard?")).toBe(false);
  });

  it('does NOT match IE (information extraction / temporal)', () => {
    expect(isMsrQuery('When does my first sprint end?')).toBe(false);
  });

  it('does NOT match SUM (summarization of one project)', () => {
    expect(isMsrQuery('Summarize my budget tracker project')).toBe(false);
  });

  it('does NOT match CR (contradiction / single-conversation lookup)', () => {
    expect(isMsrQuery('Have I ever worked on Flask routes?')).toBe(false);
  });

  it('does NOT match a numeric-count NOT spanning sessions', () => {
    expect(isMsrQuery('How many users are signed up to my dashboard?')).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(isMsrQuery('')).toBe(false);
  });
});
