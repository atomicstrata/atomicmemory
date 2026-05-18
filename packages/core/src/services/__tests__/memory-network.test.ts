/**
 * Unit tests for 4-network memory classification and opinion confidence.
 */

import { describe, it, expect } from 'vitest';
import { classifyNetwork, applyOpinionSignal, audnActionToOpinionSignal } from '../memory-network.js';
import type { ExtractedFact } from '../extraction.js';

function makeFact(overrides: Partial<ExtractedFact>): ExtractedFact {
  return {
    fact: 'test fact',
    headline: 'test',
    importance: 0.5,
    type: 'knowledge',
    keywords: [],
    entities: [],
    relations: [],
    ...overrides,
  };
}

describe('classifyNetwork', () => {
  it('classifies preferences with opinion signals as opinion', () => {
    const result = classifyNetwork(makeFact({
      fact: 'I prefer PostgreSQL over MongoDB for data storage',
      type: 'preference',
    }));
    expect(result.network).toBe('opinion');
    expect(result.opinionConfidence).toBe(0.7);
  });

  it('classifies subjective beliefs as opinion even without preference type', () => {
    const result = classifyNetwork(makeFact({
      fact: 'I think React is overrated compared to Vue',
      type: 'knowledge',
    }));
    expect(result.network).toBe('opinion');
    expect(result.opinionConfidence).toBe(0.7);
  });

  it('classifies objective world facts as world', () => {
    const result = classifyNetwork(makeFact({
      fact: 'TypeScript 5.4 was released in March 2024',
      type: 'knowledge',
    }));
    expect(result.network).toBe('world');
    expect(result.opinionConfidence).toBeNull();
  });

  it('classifies person facts as experience', () => {
    const result = classifyNetwork(makeFact({
      fact: 'User works at Google as a senior engineer',
      type: 'person',
    }));
    expect(result.network).toBe('experience');
    expect(result.opinionConfidence).toBeNull();
  });

  it('classifies plan facts as experience', () => {
    const result = classifyNetwork(makeFact({
      fact: 'User plans to switch to Rust for the next project',
      type: 'plan',
    }));
    expect(result.network).toBe('experience');
    expect(result.opinionConfidence).toBeNull();
  });

  it('defaults to experience for ambiguous knowledge facts', () => {
    const result = classifyNetwork(makeFact({
      fact: 'User has been using Kubernetes for deployment for 3 years',
      type: 'knowledge',
    }));
    expect(result.network).toBe('experience');
    expect(result.opinionConfidence).toBeNull();
  });
});

describe('applyOpinionSignal', () => {
  it('reinforces confidence by +0.1', () => {
    expect(applyOpinionSignal(0.7, 'reinforce')).toBeCloseTo(0.8);
  });

  it('weakens confidence by -0.1', () => {
    expect(applyOpinionSignal(0.7, 'weaken')).toBeCloseTo(0.6);
  });

  it('contradicts confidence by -0.2', () => {
    expect(applyOpinionSignal(0.7, 'contradict')).toBeCloseTo(0.5);
  });

  it('clamps at 1.0 on reinforce', () => {
    expect(applyOpinionSignal(0.95, 'reinforce')).toBe(1.0);
  });

  it('clamps at 0.0 on contradict', () => {
    expect(applyOpinionSignal(0.1, 'contradict')).toBe(0.0);
  });

  it('does not go negative', () => {
    expect(applyOpinionSignal(0.0, 'contradict')).toBe(0.0);
    expect(applyOpinionSignal(0.05, 'weaken')).toBe(0.0);
  });
});

describe('audnActionToOpinionSignal', () => {
  it('maps NOOP to reinforce', () => {
    expect(audnActionToOpinionSignal('NOOP')).toBe('reinforce');
  });

  it('maps UPDATE to weaken', () => {
    expect(audnActionToOpinionSignal('UPDATE')).toBe('weaken');
  });

  it('maps SUPERSEDE to contradict', () => {
    expect(audnActionToOpinionSignal('SUPERSEDE')).toBe('contradict');
  });

  it('maps DELETE to contradict', () => {
    expect(audnActionToOpinionSignal('DELETE')).toBe('contradict');
  });
});
