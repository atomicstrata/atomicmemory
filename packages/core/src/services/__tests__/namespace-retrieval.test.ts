/**
 * Unit tests for namespace-aware retrieval logic.
 * Tests pure functions for scope matching, SQL clause building,
 * namespace inference, and hierarchy traversal.
 */

import { describe, it, expect } from 'vitest';
import {
  parseNamespace,
  isInScope,
  buildNamespaceClause,
  inferNamespace,
  getAncestorScopes,
} from '../namespace-retrieval.js';

describe('parseNamespace', () => {
  it('splits dot-separated segments', () => {
    expect(parseNamespace('project.atomicmem.backend')).toEqual(['project', 'atomicmem', 'backend']);
  });

  it('returns empty array for empty string', () => {
    expect(parseNamespace('')).toEqual([]);
  });

  it('handles single segment', () => {
    expect(parseNamespace('project')).toEqual(['project']);
  });

  it('filters empty segments from double dots', () => {
    expect(parseNamespace('project..backend')).toEqual(['project', 'backend']);
  });
});

describe('isInScope', () => {
  it('matches exact namespace', () => {
    expect(isInScope('project.atomicmem', 'project.atomicmem')).toBe(true);
  });

  it('matches child namespace', () => {
    expect(isInScope('project.atomicmem.backend', 'project.atomicmem')).toBe(true);
  });

  it('rejects sibling namespace', () => {
    expect(isInScope('project.other', 'project.atomicmem')).toBe(false);
  });

  it('rejects parent namespace (too short)', () => {
    expect(isInScope('project', 'project.atomicmem')).toBe(false);
  });

  it('null scope matches everything', () => {
    expect(isInScope('project.atomicmem', null)).toBe(true);
    expect(isInScope(null, null)).toBe(true);
  });

  it('null memory namespace matches any scope', () => {
    expect(isInScope(null, 'project.atomicmem')).toBe(true);
  });

  it('empty scope matches everything', () => {
    expect(isInScope('project.atomicmem', '')).toBe(true);
  });
});

describe('buildNamespaceClause', () => {
  it('returns null for null scope', () => {
    expect(buildNamespaceClause(null, 0)).toBeNull();
  });

  it('returns null for empty scope', () => {
    expect(buildNamespaceClause('', 0)).toBeNull();
  });

  it('builds clause with correct parameter offsets', () => {
    const result = buildNamespaceClause('project.atomicmem', 2);
    expect(result).not.toBeNull();
    expect(result!.clause).toContain('$3');
    expect(result!.clause).toContain('$4');
    expect(result!.params).toEqual(['project.atomicmem', 'project.atomicmem.%']);
  });

  it('includes NULL namespace in results', () => {
    const result = buildNamespaceClause('project.atomicmem', 0);
    expect(result!.clause).toContain('m.namespace IS NULL');
  });

  it('escapes SQL wildcards in scope', () => {
    const result = buildNamespaceClause('project.test%scope', 0);
    expect(result!.params[1]).toBe('project.test\\%scope.%');
  });
});

describe('inferNamespace', () => {
  it('infers site namespace from sourceSite', () => {
    const ns = inferNamespace('Some content', 'github.com', []);
    expect(ns).toBe('site/github/com');
  });

  it('returns null for unknown sourceSite', () => {
    const ns = inferNamespace('Some content', 'unknown', []);
    expect(ns).toBeNull();
  });

  it('infers topic.databases from database keywords', () => {
    const ns = inferNamespace('We use PostgreSQL for storage', '', ['postgresql', 'storage']);
    expect(ns).toBe('topic/databases');
  });

  it('infers topic.frontend from frontend keywords', () => {
    const ns = inferNamespace('React component design', '', ['react', 'component']);
    expect(ns).toBe('topic/frontend');
  });

  it('returns null when no signals match', () => {
    const ns = inferNamespace('The weather is nice today', '', ['weather']);
    expect(ns).toBeNull();
  });
});

describe('getAncestorScopes', () => {
  it('returns all prefix paths', () => {
    expect(getAncestorScopes('project.atomicmem.backend')).toEqual([
      'project',
      'project.atomicmem',
      'project.atomicmem.backend',
    ]);
  });

  it('returns single element for single segment', () => {
    expect(getAncestorScopes('project')).toEqual(['project']);
  });

  it('returns empty array for empty string', () => {
    expect(getAncestorScopes('')).toEqual([]);
  });
});
