/**
 * Unit tests for deterministic fact normalization.
 * Guards the atomic-fact post-processing that preserves single-hop coverage.
 */

import { describe, expect, it } from 'vitest';
import { normalizeExtractedFacts } from '../fact-normalization.js';

describe('normalizeExtractedFacts', () => {
  it('splits recommendation attributions into separate memories', () => {
    const normalized = normalizeExtractedFacts([
      {
        fact: 'As of January 15, 2026, user is using Supabase for the database and authentication in their project, as recommended by their colleague Jake.',
        importance: 0.7,
        type: 'project',
        keywords: ['Supabase', 'Jake'],
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized.map((fact) => fact.fact)).toEqual([
      'As of January 15, 2026, user is using Supabase for the database and authentication in their project.',
      'As of January 15, 2026, Jake recommended Supabase for the database and authentication in their project.',
    ]);
  });

  it('splits because clauses into separate reason memories', () => {
    const normalized = normalizeExtractedFacts([
      {
        fact: 'User prefers dark mode because bright screens cause eye strain.',
        importance: 0.6,
        type: 'preference',
        keywords: ['dark mode'],
      },
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].fact).toBe('User prefers dark mode.');
    expect(normalized[1].fact).toBe('User reports that Bright screens cause eye strain.');
  });

  it('splits switch facts into clean current-state and historical transition memories', () => {
    const normalized = normalizeExtractedFacts([
      {
        fact: 'As of March 2026, user switched away from Mem0 and built their own internal AtomicMemory memory engine.',
        importance: 0.8,
        type: 'project',
        keywords: ['Mem0', 'AtomicMemory'],
      },
    ]);

    expect(normalized).toHaveLength(3);
    expect(normalized.map((fact) => fact.fact)).toEqual([
      'As of March 2026, user uses their own internal AtomicMemory memory engine.',
      "As of March 2026, user's current memory backend is their own internal AtomicMemory memory engine.",
      'As of March 2026, user switched away from Mem0.',
    ]);
    expect(normalized[0]?.keywords).toEqual(['AtomicMemory']);
    expect(normalized[1]?.keywords).toEqual(['AtomicMemory', 'memory backend', 'backend']);
    expect(normalized[2]?.keywords).toEqual(['Mem0']);
  });

  it('normalizes named pet alias facts into searchable ownership facts', () => {
    const normalized = normalizeExtractedFacts([
      {
        fact: "As of August 23 2023, Oscar, user's guinea pig.",
        importance: 0.5,
        type: 'knowledge',
        keywords: ['Oscar'],
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.fact).toBe('As of August 23 2023, user has a guinea pig named Oscar.');
    expect(normalized[0]?.keywords).toContain('guinea pig');
  });
});
