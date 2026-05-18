/**
 * Unit tests for entity graph extraction and spreading activation.
 * Tests pure functions (extractEntities) and mock-free logic.
 */

import { describe, it, expect } from 'vitest';
import { extractEntities } from '../entity-graph.js';

describe('extractEntities', () => {
  it('extracts words 3+ chars, excluding stopwords', () => {
    const entities = extractEntities('User likes React and Vue');
    expect(entities).toContain('likes');
    expect(entities).toContain('react');
    expect(entities).toContain('vue');
    expect(entities).not.toContain('and');
    expect(entities).not.toContain('user');
  });

  it('normalizes to lowercase', () => {
    const entities = extractEntities('Supabase PostgreSQL TensorFlow');
    expect(entities).toContain('supabase');
    expect(entities).toContain('postgresql');
    expect(entities).toContain('tensorflow');
  });

  it('captures hyphenated and dotted terms', () => {
    const entities = extractEntities('Uses TensorFlow.js and node-postgres');
    expect(entities).toContain('tensorflow.js');
    expect(entities).toContain('node-postgres');
  });

  it('captures compound proper nouns', () => {
    const entities = extractEntities('Jake Smith recommended Supabase');
    expect(entities).toContain('jake_smith');
  });

  it('returns empty for short/stopword-only text', () => {
    const entities = extractEntities('the and for');
    expect(entities).toEqual([]);
  });

  it('deduplicates entities', () => {
    const entities = extractEntities('React React React');
    const reactCount = entities.filter((e) => e === 'react').length;
    expect(reactCount).toBe(1);
  });

  it('extracts technology names from a typical memory fact', () => {
    const entities = extractEntities(
      'User is using Supabase for the database and authentication in the finance tracker project',
    );
    expect(entities).toContain('supabase');
    expect(entities).toContain('database');
    expect(entities).toContain('authentication');
    expect(entities).toContain('finance');
    expect(entities).toContain('tracker');
  });

  it('filters uncertain markers', () => {
    const entities = extractEntities('Maybe the user might check tomorrow');
    expect(entities).not.toContain('maybe');
    expect(entities).not.toContain('might');
    expect(entities).not.toContain('check');
    expect(entities).not.toContain('tomorrow');
  });
});
