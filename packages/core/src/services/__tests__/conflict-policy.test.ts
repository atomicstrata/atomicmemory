/**
 * Unit tests for conflict-policy atomicity guards.
 * Prevents low-overlap AUDN reuse from collapsing distinct project facts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CandidateMemory, } from '../conflict-policy.js';
import type { AUDNDecision } from '../extraction.js';
import { createConflictPolicyConfigMockFactory, createCandidateFactory, createDecisionFactory } from './test-fixtures.js';
vi.mock('../../config.js', () => createConflictPolicyConfigMockFactory());
const { applyClarificationOverrides } = await import('../conflict-policy.js');

const makeCandidate = createCandidateFactory({
  id: 'cand-1',
  content: 'As of February 20, 2026, user started a second project called dotctl, which is a CLI tool for managing dotfiles across machines.',
  similarity: 0.86,
  importance: 0.6,
}) as (overrides?: Partial<CandidateMemory>) => CandidateMemory;

const makeDecision = createDecisionFactory({
  action: 'UPDATE',
  targetMemoryId: 'cand-1',
  updatedContent: 'As of February 20, 2026, user started a second project called dotctl and wants it to be open source on GitHub.',
  contradictionConfidence: null,
  clarificationNote: null,
}) as (overrides?: Partial<AUDNDecision>) => AUDNDecision;

describe('applyClarificationOverrides', () => {
  it('promotes low-overlap updates to ADD to preserve atomic facts', () => {
    const decision = applyClarificationOverrides(
      makeDecision(),
      'As of February 20, 2026, user intends for dotctl to be open source and available on GitHub under the MIT license.',
      [makeCandidate()],
      ['dotctl', 'GitHub', 'MIT license'],
      'project',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('promotes low-overlap noops to ADD instead of skipping the fact', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: null, updatedContent: null }),
      'As of February 20, 2026, user plans to implement encryption for sensitive files in dotctl using age.',
      [makeCandidate({ similarity: 0.85 })],
      ['dotctl', 'age'],
      'project',
    );

    expect(decision.action).toBe('ADD');
  });

  it('keeps near-duplicate reuse decisions intact', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        updatedContent: 'As of January 15, 2026, user prefers dark mode in all development tools due to sensitivity to bright screens.',
      }),
      'As of January 15, 2026, user prefers dark mode for their coding sessions, especially after 10pm.',
      [
        makeCandidate({
          content: 'As of January 15, 2026, user prefers dark mode in all development tools due to sensitivity to bright screens.',
          similarity: 0.95,
        }),
      ],
      ['dark mode'],
      'preference',
    );

    expect(decision.action).toBe('UPDATE');
    expect(decision.targetMemoryId).toBe('cand-1');
  });

  it('promotes NOOP to ADD when similarity is below 0.95 threshold', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: null, updatedContent: null }),
      'User uses Supabase for the database and authentication.',
      [
        makeCandidate({
          content: 'User is using Supabase for the database and auth.',
          similarity: 0.94,
        }),
      ],
      ['Supabase'],
      'project',
    );

    expect(decision.action).toBe('ADD');
  });

  it('preserves NOOP at sim=0.95 when shared keywords >= 2', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: 'cand-1', updatedContent: null }),
      'User uses Supabase for database and authentication in the finance tracker project.',
      [
        makeCandidate({
          content: 'User is using Supabase for the database and authentication in the finance tracker.',
          similarity: 0.96,
        }),
      ],
      ['Supabase', 'finance tracker'],
      'project',
    );

    expect(decision.action).toBe('NOOP');
  });

  it('promotes NOOP to ADD at high similarity when no keywords match', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'NOOP', targetMemoryId: 'cand-1', updatedContent: null }),
      'User added tRPC for type-safe API calls end-to-end.',
      [
        makeCandidate({
          content: 'User is using Supabase for the database and authentication.',
          similarity: 0.96,
        }),
      ],
      ['tRPC'],
      'project',
    );

    expect(decision.action).toBe('ADD');
  });

  it('prevents recommendation attributions from superseding the technical fact', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
      }),
      'As of January 15, 2026, Jake recommended Supabase for the database and authentication in the new project.',
      [
        makeCandidate({
          content: 'As of January 15, 2026, user plans to use Supabase for the database and authentication in the new project.',
          similarity: 0.89,
        }),
      ],
      ['Jake', 'Supabase'],
      'person',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('allows SUPERSEDE when correction language is present (replacing)', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.9,
      }),
      'PostgreSQL with pgvector is the actual backend, replacing the earlier MongoDB choice.',
      [
        makeCandidate({
          content: 'User prefers MongoDB for the production memory backend.',
          similarity: 0.73,
          importance: 0.9,
        }),
      ],
      ['PostgreSQL', 'pgvector', 'production', 'backend'],
      'preference',
    );

    expect(decision.action).toBe('SUPERSEDE');
  });

  it('does not clarify explicit replacements when contradiction confidence is low', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.3,
      }),
      "As of March 10, 2026, user's emergency contact is Bob Chen at 555-0199, replacing Alice Morgan.",
      [
        makeCandidate({
          content: "User's emergency contact is Alice Morgan at 555-0101.",
          similarity: 0.73,
          importance: 0.8,
        }),
      ],
      ['Bob Chen', 'Alice Morgan', '555-0199'],
      'person',
    );

    expect(decision.action).toBe('SUPERSEDE');
  });

  it('allows SUPERSEDE when correction: marker is present', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.9,
      }),
      'Correction: PostgreSQL is the actual production backend, not MongoDB.',
      [
        makeCandidate({
          content: 'User prefers MongoDB for the production memory backend.',
          similarity: 0.73,
          importance: 0.9,
        }),
      ],
      ['PostgreSQL', 'production', 'backend'],
      'preference',
    );

    expect(decision.action).toBe('SUPERSEDE');
  });

  it('blocks SUPERSEDE of critical memory when no correction signal exists', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'SUPERSEDE',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.9,
      }),
      'User wants PostgreSQL for the production backend.',
      [
        makeCandidate({
          content: 'User prefers MongoDB for the production memory backend.',
          similarity: 0.73,
          importance: 0.9,
        }),
      ],
      ['PostgreSQL', 'production', 'backend'],
      'preference',
    );

    expect(decision.action).toBe('ADD');
  });

  it('keeps historical transition facts separate from current-state memories', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'UPDATE',
        targetMemoryId: 'cand-1',
        updatedContent: 'As of March 2026, user uses the internal AtomicMemory engine. As of March 2026, user switched away from Mem0.',
      }),
      'As of March 2026, user switched away from Mem0.',
      [
        makeCandidate({
          content: 'As of March 2026, user uses the internal AtomicMemory engine.',
          similarity: 0.97,
        }),
      ],
      ['Mem0'],
      'project',
    );

    expect(decision.action).toBe('ADD');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('does not treat medical check-up facts as uncertain language', () => {
    const decision = applyClarificationOverrides(
      makeDecision({ action: 'ADD', targetMemoryId: null, updatedContent: null }),
      "Sam had a check-up with Sam's doctor a few days ago.",
      [
        makeCandidate({
          content: 'Sam is working on healthier habits.',
          similarity: 0.83,
        }),
      ],
      ['doctor', 'check-up'],
      'knowledge',
    );

    expect(decision.action).toBe('ADD');
  });

  it('upgrades CLARIFY with a valid target + explicit replacement to SUPERSEDE', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'CLARIFY',
        targetMemoryId: 'cand-1',
        updatedContent: null,
        contradictionConfidence: 0.4,
        clarificationNote: 'AUDN uncertain — needs user confirmation',
      }),
      'Replacing my advisor Alice Morgan with Bob Chen.',
      [makeCandidate({ content: 'My advisor is Alice Morgan.' })],
      ['advisor', 'Bob', 'Chen'],
      'person',
    );

    expect(decision.action).toBe('SUPERSEDE');
    expect(decision.targetMemoryId).toBe('cand-1');
  });

  it('keeps CLARIFY when explicit replacement signal has no identified target', () => {
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'CLARIFY',
        targetMemoryId: null,
        updatedContent: null,
        contradictionConfidence: 0.4,
        clarificationNote: 'AUDN uncertain',
      }),
      'No longer using the old workflow.',
      [makeCandidate({ similarity: 0.6 })],
      ['workflow'],
      'knowledge',
    );

    expect(decision.action).toBe('CLARIFY');
    expect(decision.targetMemoryId).toBeNull();
  });

  it('keeps CLARIFY when explicit replacement target is not in the candidate set', () => {
    // AUDN returned a stale/invalid targetMemoryId. Superseding would be
    // rejected downstream by memory-audn (missing target), falling back
    // to canonical storage and leaving the old memory active. Defer to
    // the user instead.
    const decision = applyClarificationOverrides(
      makeDecision({
        action: 'CLARIFY',
        targetMemoryId: 'stale-id-not-in-candidates',
        updatedContent: null,
        contradictionConfidence: 0.4,
      }),
      'Replacing my advisor Alice Morgan with Bob Chen.',
      [makeCandidate({ id: 'cand-1', content: 'My advisor is Alice Morgan.' })],
      ['advisor', 'Bob', 'Chen'],
      'person',
    );

    expect(decision.action).toBe('CLARIFY');
    expect(decision.targetMemoryId).toBe('stale-id-not-in-candidates');
  });
});
