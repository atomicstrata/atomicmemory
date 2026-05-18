/**
 * Tests for observation-date extraction helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  applyObservationDateAnchors,
  buildExtractionUserMessage,
} from '../observation-date-extraction.js';
import type { ExtractedFact } from '../extraction.js';

function fact(text: string): ExtractedFact {
  return {
    fact: text,
    headline: 'Temporal fact',
    importance: 0.7,
    type: 'knowledge',
    keywords: [],
    entities: [],
    relations: [],
  };
}

describe('buildExtractionUserMessage', () => {
  it('keeps the existing prompt shape when observation date extraction is off', () => {
    const message = buildExtractionUserMessage('[Session date: 2023-08-14]\nUser: I went last Friday.');

    expect(message).toBe('Conversation to extract from:\n[Session date: 2023-08-14]\nUser: I went last Friday.');
  });

  it('adds an explicit observation timestamp when enabled and available', () => {
    const message = buildExtractionUserMessage(
      '[Session date: 2023-08-14T14:24:00.000Z]\nUser: I went last Friday.',
      { observationDateExtractionEnabled: true },
    );

    expect(message).toContain('Observation timestamp: 2023-08-14T14:24:00.000Z');
    expect(message).toContain('resolve relative dates');
    expect(message).toContain('Conversation to extract from:');
  });
});

describe('applyObservationDateAnchors', () => {
  it('annotates relative dates in extracted facts when enabled', () => {
    const [anchored] = applyObservationDateAnchors(
      [fact('Caroline went to the adoption meeting last Friday.')],
      '[Session date: 2023-07-15T13:51:00.000Z]\nCaroline: I went last Friday.',
      { observationDateExtractionEnabled: true },
    );

    expect(anchored?.fact).toContain('last Friday (on July 14, 2023)');
    expect(anchored?.keywords).toContain('2023-07-14');
  });

  it('does not annotate when the flag is off', () => {
    const [anchored] = applyObservationDateAnchors(
      [fact('Caroline went to the adoption meeting last Friday.')],
      '[Session date: 2023-07-15T13:51:00.000Z]\nCaroline: I went last Friday.',
    );

    expect(anchored?.fact).toBe('Caroline went to the adoption meeting last Friday.');
  });
});
