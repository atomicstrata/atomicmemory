/**
 * Unit tests for the deterministic MSR (Multi-Session Reasoning) specialist.
 *
 * Verifies pattern detection, action-verb extraction, verb-based filtering,
 * entity deduplication, and number-word formatting. No LLM mocking needed
 * since the new implementation makes zero LLM calls.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldInvokeMsrSpecialist,
  runMsrSpecialist,
  detectActionVerb,
} from '../msr-specialist.js';

describe('shouldInvokeMsrSpecialist', () => {
  it('matches "how many"', () => {
    expect(shouldInvokeMsrSpecialist('How many features did I add?')).toBe(true);
  });
  it('matches "how many" (varied casing)', () => {
    expect(shouldInvokeMsrSpecialist('How many user roles am I implementing?')).toBe(true);
  });
  it('matches "across all"', () => {
    expect(shouldInvokeMsrSpecialist('What did I mention across all my sessions?')).toBe(true);
  });
  it('matches "total number of"', () => {
    expect(shouldInvokeMsrSpecialist('What is the total number of bugs I fixed?')).toBe(true);
  });
  it('does not match regular questions', () => {
    expect(shouldInvokeMsrSpecialist('When does my sprint end?')).toBe(false);
    expect(shouldInvokeMsrSpecialist('Give me a summary.')).toBe(false);
  });
});

describe('detectActionVerb', () => {
  it('detects "wanting to add"', () => {
    const v = detectActionVerb('How many columns did I want to add?');
    expect(v?.verb).toBe('add');
  });
  it('detects "wanting to handle"', () => {
    const v = detectActionVerb('How many features did I mention wanting to handle?');
    expect(v?.verb).toBe('handle');
  });
  it('detects "mentioned"', () => {
    const v = detectActionVerb('How many bugs did I mention?');
    expect(v?.verb).toBe('mention');
  });
  it('detects "fixing"', () => {
    const v = detectActionVerb('How many issues did I spend time fixing?');
    expect(v?.verb).toBe('fix');
  });
  it('returns null for ambiguous questions with no known verb', () => {
    const v = detectActionVerb('How many things are there?');
    expect(v).toBeNull();
  });
});

describe('runMsrSpecialist — deterministic', () => {
  it('returns handled=false and usedLlm=false when query does not match', async () => {
    const r = await runMsrSpecialist({
      memories: [{ id: 'm1', text: 'foo' }],
      query: 'When does my sprint end?',
    });
    expect(r.handled).toBe(false);
    expect(r.usedLlm).toBe(false);
    expect(r.answer).toBe('');
  });

  it('returns "Zero" when no memories retrieved', async () => {
    const r = await runMsrSpecialist({
      memories: [],
      query: 'How many things did I mention?',
    });
    expect(r.handled).toBe(true);
    expect(r.usedLlm).toBe(false);
    expect(r.answer).toBe('Zero');
  });

  it('filters by verb: counts only memories matching "wanting to handle" (smoke v5 scenario)', async () => {
    const r = await runMsrSpecialist({
      memories: [
        { id: 'm1', text: 'user wanting to handle network errors' },
        { id: 'm2', text: 'user wanting to handle invalid city names' },
        { id: 'm3', text: 'user wanting to handle promise rejections' },
        { id: 'm4', text: 'user wanting to handle HTTP 401 responses' },
        { id: 'm5', text: 'discussion about debounce delay' },
        { id: 'm6', text: 'discussion about css color themes' },
      ],
      query: 'How many features did I mention wanting to handle across my weather app conversations?',
    });
    expect(r.handled).toBe(true);
    expect(r.usedLlm).toBe(false);
    // 4 "wanting to handle" items; 2 irrelevant discussions excluded
    expect(r.items.length).toBe(4);
    expect(r.answer).toBe('Four');
  });

  it('returns "Two" for 2 distinct add-column memories', async () => {
    const r = await runMsrSpecialist({
      memories: [
        { id: 'm1', text: 'user wants to add category column' },
        { id: 'm2', text: 'user wants to add notes column' },
      ],
      query: 'How many new columns did I want to add?',
    });
    expect(r.handled).toBe(true);
    expect(r.usedLlm).toBe(false);
    expect(r.items.length).toBe(2);
    expect(r.answer).toBe('Two');
  });

  it('deduplicates near-identical memories', async () => {
    const r = await runMsrSpecialist({
      memories: [
        { id: 'm1', text: 'user wants to add category column to task list' },
        { id: 'm2', text: 'user wants to add category column' }, // duplicate
        { id: 'm3', text: 'user wants to add notes column' },
      ],
      query: 'How many columns did I want to add?',
    });
    expect(r.handled).toBe(true);
    // m1 and m2 overlap — should collapse to 2 distinct items
    expect(r.items.length).toBe(2);
    expect(r.answer).toBe('Two');
  });

  it('falls back to all memories when no action verb detected', async () => {
    const r = await runMsrSpecialist({
      memories: [
        { id: 'm1', text: 'network timeout error in api calls' },
        { id: 'm2', text: 'database migration script failure' },
      ],
      query: 'How many things are there in total?',
    });
    expect(r.handled).toBe(true);
    expect(r.usedLlm).toBe(false);
    // No verb filter: counts all retrieved memories
    expect(r.items.length).toBe(2);
  });

  it('uses digit string for counts above 10', async () => {
    const topics = [
      'user wants to fix login page redirect',
      'user wants to fix password reset email',
      'user wants to fix avatar upload cropping',
      'user wants to fix notification badge counter',
      'user wants to fix search pagination results',
      'user wants to fix mobile sidebar overflow',
      'user wants to fix dark mode toggle persistence',
      'user wants to fix export csv encoding',
      'user wants to fix calendar timezone display',
      'user wants to fix webhook signature validation',
      'user wants to fix rate limiter headers',
    ];
    const memories = topics.map((text, i) => ({ id: `m${i}`, text }));
    const r = await runMsrSpecialist({
      memories,
      query: 'How many issues did I fix across my sessions?',
    });
    expect(r.handled).toBe(true);
    // 11 > 10 → uses digit format
    expect(r.answer).toMatch(/^11/);
  });
});
