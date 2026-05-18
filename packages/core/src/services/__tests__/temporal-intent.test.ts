/**
 * Unit tests for the temporal-intent regex classifier.
 * No DB or LLM calls — pure function tests.
 */

import { describe, expect, it } from 'vitest';
import {
  TemporalIntent,
  classifyTemporalIntent,
} from '../temporal-intent.js';

describe('classifyTemporalIntent', () => {
  it('flags "What is my current job?" as CURRENT_STATE', () => {
    expect(classifyTemporalIntent('What is my current job?'))
      .toBe(TemporalIntent.CURRENT_STATE);
  });

  it('flags "Where do I live now?" as CURRENT_STATE', () => {
    expect(classifyTemporalIntent('Where do I live now?'))
      .toBe(TemporalIntent.CURRENT_STATE);
  });

  it('flags "What is my salary today?" as CURRENT_STATE', () => {
    expect(classifyTemporalIntent('What is my salary today?'))
      .toBe(TemporalIntent.CURRENT_STATE);
  });

  it('flags "What was my role in March?" as HISTORICAL_AT_TIME', () => {
    expect(classifyTemporalIntent('What was my role in March?'))
      .toBe(TemporalIntent.HISTORICAL_AT_TIME);
  });

  it('flags "What was my salary last year?" as HISTORICAL_AT_TIME', () => {
    expect(classifyTemporalIntent('What was my salary last year?'))
      .toBe(TemporalIntent.HISTORICAL_AT_TIME);
  });

  it('flags "How long have I had this phone?" as DURATION', () => {
    expect(classifyTemporalIntent('How long have I had this phone?'))
      .toBe(TemporalIntent.DURATION);
  });

  it('returns NONE for a non-temporal lookup question', () => {
    expect(classifyTemporalIntent('Who is the project lead for AUDN?'))
      .toBe(TemporalIntent.NONE);
  });

  it('returns NONE for a summary question', () => {
    expect(classifyTemporalIntent('Summarize my conversation history.'))
      .toBe(TemporalIntent.NONE);
  });
});
