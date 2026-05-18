/**
 * Unit tests for staged loading (L0 summary injection).
 * Tests the formatting layer — no database required.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { formatInjection } from '../retrieval-format.js';
import { generateFallbackHeadline } from '../extraction.js';
import { config } from '../../config.js';
import { createSearchResult } from './test-fixtures.js';

function makeMemory(overrides: Partial<import('../../db/repository-types.js').SearchResult> = {}) {
  return createSearchResult({
    id: 'mem-001',
    content: 'User prefers Vite over Webpack for all React projects because of faster HMR',
    importance: 0.7, keywords: 'Vite Webpack React',
    summary: 'Prefers Vite over Webpack for React',
    created_at: new Date('2026-01-15'), last_accessed_at: new Date('2026-01-15'),
    similarity: 0.92, score: 0.85,
    ...overrides,
  });
}

afterEach(() => {
  config.stagedLoadingEnabled = false;
});

describe('staged loading: formatInjection', () => {
  it('returns full content when staged loading is disabled', () => {
    config.stagedLoadingEnabled = false;
    const result = formatInjection([makeMemory()]);

    expect(result).toContain('Vite over Webpack for all React projects because of faster HMR');
    expect(result).not.toContain('staged="true"');
    expect(result).not.toContain('expand_hint');
  });

  it('returns summary when staged loading is enabled', () => {
    config.stagedLoadingEnabled = true;
    const result = formatInjection([makeMemory()]);

    expect(result).toContain('Prefers Vite over Webpack for React');
    expect(result).not.toContain('because of faster HMR');
    expect(result).toContain('staged="true"');
    expect(result).toContain('mode="staged"');
  });

  it('includes expand hint and memory IDs when staged', () => {
    config.stagedLoadingEnabled = true;
    const result = formatInjection([
      makeMemory({ id: 'aaa' }),
      makeMemory({ id: 'bbb' }),
    ]);

    expect(result).toContain('expand_ids="aaa,bbb"');
    expect(result).toContain('expand_hint');
  });

  it('falls back to truncated content when summary is empty', () => {
    config.stagedLoadingEnabled = true;
    const longContent = 'Alice is working on a complex machine learning pipeline for natural language processing at her new startup';
    const result = formatInjection([makeMemory({ summary: '', content: longContent })]);

    expect(result).toContain('Alice is working on a complex machine learning pipeline for ...');
    expect(result).not.toContain('natural language processing at her new startup');
  });

  it('preserves full XML attributes in staged mode', () => {
    config.stagedLoadingEnabled = true;
    const result = formatInjection([makeMemory()]);

    expect(result).toContain('memory_id="mem-001"');
    expect(result).toContain('importance="0.7"');
    expect(result).toContain('similarity="0.92"');
    expect(result).toContain('score="0.85"');
  });

  it('returns empty string for empty memories array', () => {
    config.stagedLoadingEnabled = true;
    expect(formatInjection([])).toBe('');
  });
});

describe('staged loading: generateFallbackHeadline', () => {
  it('returns short facts unchanged', () => {
    expect(generateFallbackHeadline('User likes cats')).toBe('User likes cats');
  });

  it('truncates long facts to 10 words with ellipsis', () => {
    const long = 'User is building a complex system with many different components and services for production';
    const headline = generateFallbackHeadline(long);
    const wordCount = headline.replace('...', '').trim().split(/\s+/).length;

    expect(wordCount).toBe(10);
    expect(headline.endsWith('...')).toBe(true);
  });

  it('handles exactly 10 words without truncation', () => {
    const exact = 'one two three four five six seven eight nine ten';
    expect(generateFallbackHeadline(exact)).toBe(exact);
  });
});
