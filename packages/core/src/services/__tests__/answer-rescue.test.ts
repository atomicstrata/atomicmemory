/**
 * Unit tests for the answer-rescue module.
 * Tests abstention detection, keyword extraction, and confidence prefix injection.
 * No DB or LLM calls — all pure function tests.
 */

import { describe, expect, it } from 'vitest';
import {
  detectAbstention,
  extractKeywordsFromQuery,
  applyConfidencePrefix,
  CONFIDENCE_PREFIX,
} from '../answer-rescue.js';
import { QuestionType } from '../answer-format.js';

describe('detectAbstention', () => {
  it('matches "no information found"', () => {
    expect(detectAbstention('No information found in the retrieved context.')).toBe(true);
  });

  it('matches "cannot find"', () => {
    expect(detectAbstention('I cannot find the answer in the context.')).toBe(true);
  });

  it('matches "context does not contain"', () => {
    expect(detectAbstention('The context does not contain information about X.')).toBe(true);
  });

  it('matches "does not contain sufficient"', () => {
    expect(detectAbstention('The retrieved data does not contain sufficient information.')).toBe(true);
  });

  it('matches "cannot determine"', () => {
    expect(detectAbstention('I cannot determine the date from the context.')).toBe(true);
  });

  it('matches "retrieved context does not"', () => {
    expect(detectAbstention('The retrieved context does not include that fact.')).toBe(true);
  });

  it('does NOT match confident answers', () => {
    expect(detectAbstention('The daily call quota is 1,200 calls per day.')).toBe(false);
    expect(detectAbstention('21 days between March 29 and April 19.')).toBe(false);
  });

  it('does NOT match negative phrasing about something else', () => {
    expect(detectAbstention('Flask-Login does not support OAuth by default.')).toBe(false);
  });
});

describe('extractKeywordsFromQuery', () => {
  it('extracts quoted strings', () => {
    const kw = extractKeywordsFromQuery('What is "daily quota" for the API key?');
    expect(kw).toContain('daily quota');
  });

  it('extracts capitalized noun phrases', () => {
    const kw = extractKeywordsFromQuery('What is the OpenWeather API quota?');
    expect(kw).toContain('OpenWeather');
  });

  it('extracts hyphenated compounds', () => {
    const kw = extractKeywordsFromQuery('Have I used Flask-Login in this project?');
    expect(kw).toContain('Flask-Login');
  });

  it('deduplicates repeated terms', () => {
    const kw = extractKeywordsFromQuery('What is Flask-Login and how does Flask-Login work?');
    const parts = kw.split(' ');
    const count = parts.filter((p) => p === 'Flask-Login').length;
    expect(count).toBe(1);
  });

  it('returns empty string for lower-case only queries', () => {
    const kw = extractKeywordsFromQuery('what time is it today?');
    expect(kw).toBe('');
  });
});

describe('applyConfidencePrefix', () => {
  it('prepends prefix when enabled', () => {
    const out = applyConfidencePrefix('PROMPT_BODY', true);
    expect(out).toContain('You are answering from');
    expect(out.endsWith('PROMPT_BODY')).toBe(true);
  });

  it('includes the full CONFIDENCE_PREFIX text when enabled', () => {
    const out = applyConfidencePrefix('X', true);
    expect(out.startsWith(CONFIDENCE_PREFIX)).toBe(true);
  });

  it('returns unchanged when disabled', () => {
    const out = applyConfidencePrefix('PROMPT_BODY', false);
    expect(out).toBe('PROMPT_BODY');
  });

  it('preserves empty string when disabled', () => {
    const out = applyConfidencePrefix('', false);
    expect(out).toBe('');
  });

  it('adaptive=false keeps the forced prefix even when questionType is given', () => {
    const out = applyConfidencePrefix('X', true, { adaptive: false, questionType: QuestionType.OTHER });
    expect(out.startsWith(CONFIDENCE_PREFIX)).toBe(true);
  });

  it('adaptive=true SUMMARY uses forced CONFIDENCE_PREFIX', () => {
    const out = applyConfidencePrefix('X', true, { adaptive: true, questionType: QuestionType.SUMMARY });
    expect(out.startsWith(CONFIDENCE_PREFIX)).toBe(true);
  });

  it('adaptive=true OTHER uses SOFT prefix (no FORBIDDEN block)', () => {
    const out = applyConfidencePrefix('X', true, { adaptive: true, questionType: QuestionType.OTHER });
    expect(out).not.toContain('FORBIDDEN PHRASES');
    expect(out).toContain('OUTPUT PHRASING');
  });

  it('adaptive=true ABSTAIN returns prompt unchanged', () => {
    const out = applyConfidencePrefix('PROMPT_BODY', true, { adaptive: true, questionType: QuestionType.ABSTAIN });
    expect(out).toBe('PROMPT_BODY');
  });
});
