/**
 * Unit tests for AUDN stability guards (2026-03-18).
 *
 * Validates the three changes that stabilize memory count across runs:
 *   1. preserveAtomicFacts guards ALL fact types (not just project/recommendation)
 *   2. SAFE_REUSE_MIN_SIMILARITY tightened to 0.95
 *   3. Content-length growth guard rejects UPDATE when merged content >50% longer
 *
 * These prevent the 21-vs-51 memory count swings caused by AUDN non-determinism
 * in UPDATE/NOOP decisions across runs.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AUDNDecision } from '../extraction.js';
import type { CandidateMemory } from '../conflict-policy.js';
import { createCandidateFactory, createDecisionFactory, createConflictPolicyConfigMockFactory } from './test-fixtures.js';
vi.mock('../../config.js', () => createConflictPolicyConfigMockFactory());
const { applyClarificationOverrides } = await import('../conflict-policy.js');

const makeCandidate = createCandidateFactory({
  id: 'cand-1',
  content: 'User prefers Tailwind CSS for styling.',
  similarity: 0.88,
  importance: 0.5,
}) as (overrides?: Partial<CandidateMemory>) => CandidateMemory;

const makeDecision = createDecisionFactory({
  action: 'UPDATE',
  targetMemoryId: 'cand-1',
  updatedContent: 'User prefers Tailwind CSS for styling in all projects.',
  contradictionConfidence: null,
  clarificationNote: null,
}) as (overrides?: Partial<AUDNDecision>) => AUDNDecision;

describe('AUDN stability: all fact types guarded', () => {
  it('promotes UPDATE to ADD for preference facts with low similarity', () => {
    const decision = applyClarificationOverrides(
      makeDecision(),
      'User prefers dark mode in VS Code.',
      [makeCandidate({ similarity: 0.88 })],
      ['dark mode', 'VS Code'],
      'preference',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('promotes NOOP to ADD for person facts with low similarity', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: null, updatedContent: null }),
      'Jake is the team lead on the backend team.',
      [makeCandidate({
        content: 'Jake recommended using Go for the CLI tool.',
        similarity: 0.82,
      })],
      ['Jake', 'backend'],
      'person',
    );

    expect(decision.action).toBe('ADD');
  });

  it('promotes UPDATE to ADD for technical facts with low similarity', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: 'User uses PostgreSQL with Supabase for the finance tracker database and authentication.',
      }),
      'User uses Supabase for authentication in the finance tracker.',
      [makeCandidate({
        content: 'User uses PostgreSQL for the finance tracker database.',
        similarity: 0.87,
      })],
      ['Supabase', 'authentication'],
      'technical',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('promotes UPDATE to ADD for null fact type', () => {
    const decision = applyClarificationOverrides(
      makeDecision(),
      'User lives in San Francisco.',
      [makeCandidate({ similarity: 0.80 })],
      ['San Francisco'],
      null,
    );

    expect(decision.action).toBe('ADD');
  });
});

describe('AUDN stability: similarity threshold at 0.95', () => {
  it('rejects UPDATE at similarity 0.94 even with shared keywords', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: 'User prefers Tailwind CSS for all frontend styling.',
      }),
      'User prefers Tailwind CSS for frontend styling.',
      [makeCandidate({
        content: 'User prefers Tailwind CSS for styling.',
        similarity: 0.94,
      })],
      ['Tailwind', 'styling'],
      'preference',
    );

    expect(decision.action).toBe('ADD');
  });

  it('allows UPDATE at similarity 0.96 with shared keywords', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: 'User prefers Tailwind CSS for styling all components.',
      }),
      'User prefers Tailwind CSS for styling all components.',
      [makeCandidate({
        content: 'User prefers Tailwind CSS for styling.',
        similarity: 0.96,
      })],
      ['Tailwind', 'styling'],
      'preference',
    );

    expect(decision.action).toBe('UPDATE');
  });

  it('rejects NOOP at similarity 0.93 — fact would be silently lost', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: 'cand-1', updatedContent: null }),
      'User is learning Rust and completed chapters 1-4.',
      [makeCandidate({
        content: 'User is learning Rust.',
        similarity: 0.93,
      })],
      ['Rust'],
      'technical',
    );

    expect(decision.action).toBe('ADD');
  });
});

describe('AUDN stability: content growth guard', () => {
  it('rejects UPDATE when merged content grows more than 50%', () => {
    const shortOriginal = 'User uses Go for dotctl.';
    const longMerged = 'User uses Go for dotctl, which is a CLI tool for managing dotfiles across machines, with plans to open source it under the MIT license on GitHub.';

    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: longMerged,
        targetMemoryId: 'cand-1',
      }),
      'User plans to open source dotctl under the MIT license on GitHub.',
      [makeCandidate({
        content: shortOriginal,
        similarity: 0.96,
      })],
      ['dotctl', 'MIT', 'GitHub'],
      'project',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('allows UPDATE when content growth is within 50%', () => {
    const original = 'User prefers Tailwind CSS for styling in all projects.';
    const slightlyLonger = 'User prefers Tailwind CSS for styling in all frontend projects.';

    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: slightlyLonger,
        targetMemoryId: 'cand-1',
      }),
      'User prefers Tailwind CSS for styling in all frontend projects.',
      [makeCandidate({
        content: original,
        similarity: 0.97,
      })],
      ['Tailwind', 'styling'],
      'preference',
    );

    expect(decision.action).toBe('UPDATE');
  });

  it('does not apply growth guard to NOOP (no updatedContent)', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: 'cand-1', updatedContent: null }),
      'User prefers Tailwind CSS for styling.',
      [makeCandidate({
        content: 'User prefers Tailwind CSS for styling.',
        similarity: 0.98,
      })],
      ['Tailwind', 'styling'],
      'preference',
    );

    expect(decision.action).toBe('NOOP');
  });
});

describe('AUDN stability: ADD and SUPERSEDE pass through unaffected', () => {
  it('does not interfere with ADD decisions', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'ADD', targetMemoryId: null, updatedContent: null }),
      'User started learning Kubernetes this week.',
      [makeCandidate({ similarity: 0.70 })],
      ['Kubernetes'],
      'technical',
    );

    expect(decision.action).toBe('ADD');
  });

  it('does not interfere with SUPERSEDE decisions (no contradiction signal)', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.9,
      }),
      'User prefers Zed as their primary editor.',
      [makeCandidate({
        content: 'User prefers VS Code for development.',
        similarity: 0.85,
      })],
      ['Zed'],
      'preference',
    );

    expect(decision.action).toBe('SUPERSEDE');
  });
});
