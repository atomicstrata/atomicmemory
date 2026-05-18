/**
 * Unit tests for the answer-format alignment classifier and hint applier
 * (Sprint 5 Layer 1). Verifies that:
 *   - Each documented question-type pattern routes to the correct enum value.
 *   - Unmatched queries fall through to OTHER.
 *   - `applyFormatHint` respects the enabled flag and the "no hint" types.
 */

import { describe, expect, it } from 'vitest';
import {
  QuestionType,
  applyFormatHint,
  classifyQuestion,
  getOutputFormatHint,
  isKuStyleQuery,
} from '../answer-format.js';

describe('classifyQuestion', () => {
  it('classifies "how many" as NUMERIC_COUNT', () => {
    expect(classifyQuestion('How many features did I add?')).toBe(QuestionType.NUMERIC_COUNT);
  });

  it('classifies "when does" as EXACT_DATE', () => {
    expect(classifyQuestion('When does my first sprint end?')).toBe(QuestionType.EXACT_DATE);
  });

  it('classifies "list ... in order" as ORDERED_LIST', () => {
    expect(classifyQuestion('List in order the items I added.')).toBe(QuestionType.ORDERED_LIST);
  });

  it('classifies "Have I ever" as CONTRADICTION', () => {
    expect(classifyQuestion('Have I ever used Flask-Login?')).toBe(QuestionType.CONTRADICTION);
  });

  it('classifies "comprehensive summary" as SUMMARY', () => {
    expect(classifyQuestion('Give me a comprehensive summary.')).toBe(QuestionType.SUMMARY);
  });

  it('classifies "what would you suggest" as PREFERENCE', () => {
    expect(classifyQuestion('What would you suggest for caching?')).toBe(QuestionType.PREFERENCE);
  });

  it('returns OTHER for unrelated text', () => {
    expect(classifyQuestion('Random unrelated text.')).toBe(QuestionType.OTHER);
  });

  it('does NOT classify "list common errors" as ORDERED_LIST (no numeric token)', () => {
    expect(classifyQuestion('What are some common responses when an API fails? List them.')).toBe(
      QuestionType.OTHER,
    );
  });

  it('classifies "list five items in order" as ORDERED_LIST (numeric token present)', () => {
    expect(classifyQuestion('Can you list five items in order?')).toBe(QuestionType.ORDERED_LIST);
  });

  it('classifies "Mention ONLY three items" as ORDERED_LIST (numeric token present)', () => {
    expect(classifyQuestion('List them in order. Mention ONLY three items.')).toBe(
      QuestionType.ORDERED_LIST,
    );
  });

  // v42: KU-style metric/state framings — route to NUMERIC_COUNT so they
  // pick up the forced-commit prefix.
  it('classifies "what is the average response time" as NUMERIC_COUNT', () => {
    expect(classifyQuestion('What is the average response time of the dashboard API?')).toBe(
      QuestionType.NUMERIC_COUNT,
    );
  });

  it('classifies "what is the daily call quota" as NUMERIC_COUNT', () => {
    expect(
      classifyQuestion('What is the daily call quota for the API key used in my application?'),
    ).toBe(QuestionType.NUMERIC_COUNT);
  });

  it('classifies "what is my accuracy percentage" as NUMERIC_COUNT', () => {
    expect(
      classifyQuestion(
        'What is my accuracy percentage in solving area calculation problems after completing 15 problems?',
      ),
    ).toBe(QuestionType.NUMERIC_COUNT);
  });

  it('does NOT classify "what is a good way to refactor" as NUMERIC_COUNT', () => {
    expect(classifyQuestion("What's a good way to refactor this?")).toBe(QuestionType.OTHER);
  });
});

describe('isKuStyleQuery', () => {
  it('matches "what is the average X"', () => {
    expect(isKuStyleQuery('What is the average response time of the dashboard API?')).toBe(true);
  });

  it('matches "what is the daily X"', () => {
    expect(isKuStyleQuery('What is the daily call quota?')).toBe(true);
  });

  it('matches "what is my current X"', () => {
    expect(isKuStyleQuery('What is my current accuracy percentage?')).toBe(true);
  });

  it('does NOT match "what is a good way"', () => {
    expect(isKuStyleQuery("What's a good way to refactor this?")).toBe(false);
  });
});

describe('applyFormatHint', () => {
  it('prepends the NUMERIC_COUNT hint when enabled', () => {
    const out = applyFormatHint('PROMPT_BODY', 'How many?', true);
    expect(out).not.toBe('PROMPT_BODY');
    expect(out).toContain(getOutputFormatHint(QuestionType.NUMERIC_COUNT));
    expect(out.endsWith('PROMPT_BODY')).toBe(true);
  });

  it('returns the prompt unchanged when disabled', () => {
    const out = applyFormatHint('PROMPT_BODY', 'How many?', false);
    expect(out).toBe('PROMPT_BODY');
  });

  it('returns the prompt unchanged when the classified type has no hint', () => {
    const out = applyFormatHint('PROMPT_BODY', 'Random.', true);
    expect(out).toBe('PROMPT_BODY');
  });
});

describe('getOutputFormatHint (patched)', () => {
  it('ORDERED_LIST hint allows partial answers when items < requested count', () => {
    const hint = getOutputFormatHint(QuestionType.ORDERED_LIST);
    expect(hint).toContain('if retrievable');
    expect(hint.toLowerCase()).not.toMatch(/exactly the count requested/);
  });
});
