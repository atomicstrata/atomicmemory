/**
 * Unit tests for deriveMajorityNamespace — the helper that assigns
 * a composite memory's namespace from its member atomics' namespaces.
 */

import { describe, it, expect } from 'vitest';
import { deriveMajorityNamespace } from '../namespace-retrieval.js';

describe('deriveMajorityNamespace', () => {
  it('returns null when all members have null namespace', () => {
    expect(deriveMajorityNamespace([null, null, null])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(deriveMajorityNamespace([])).toBeNull();
  });

  it('returns the single non-null namespace', () => {
    expect(deriveMajorityNamespace([null, 'site/lab', null])).toBe('site/lab');
  });

  it('returns the unanimous namespace', () => {
    expect(deriveMajorityNamespace(['topic/frontend', 'topic/frontend'])).toBe('topic/frontend');
  });

  it('returns the most common namespace when mixed', () => {
    const result = deriveMajorityNamespace([
      'topic/frontend',
      'topic/frontend',
      'topic/databases',
    ]);
    expect(result).toBe('topic/frontend');
  });

  it('ignores null when counting majority', () => {
    const result = deriveMajorityNamespace([
      null,
      'site/chatgpt',
      null,
      'site/chatgpt',
      'topic/testing',
    ]);
    expect(result).toBe('site/chatgpt');
  });

  it('picks one when counts are tied (deterministic)', () => {
    const result = deriveMajorityNamespace([
      'topic/frontend',
      'topic/databases',
    ]);
    expect(result).not.toBeNull();
    expect(['topic/frontend', 'topic/databases']).toContain(result);
  });

  it('handles single-member input', () => {
    expect(deriveMajorityNamespace(['project/atomicmem/docs'])).toBe('project/atomicmem/docs');
  });

  it('handles single null input', () => {
    expect(deriveMajorityNamespace([null])).toBeNull();
  });
});
