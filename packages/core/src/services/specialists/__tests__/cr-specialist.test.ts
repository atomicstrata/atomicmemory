/**
 * Unit tests for the CR (Contradiction Resolution) specialist.
 *
 * All LLM and DB calls are mocked — no Postgres or Anthropic API required.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  shouldInvokeCrSpecialist,
  runCrSpecialist,
  type CrSpecialistDeps,
} from '../cr-specialist.js';

vi.mock('../../llm.js', () => ({
  callAnthropicTool: vi.fn(),
}));

import { callAnthropicTool } from '../../llm.js';

/** Build a fake BeliefEdgesRepository stub. */
function fakeBeliefEdges(
  edges: Array<{ sourceId: string; targetId: string; rationale?: string }>,
): CrSpecialistDeps['beliefEdges'] {
  return {
    findCounterEdgesForMemories: vi.fn().mockResolvedValue(
      edges.map(e => ({ ...e, rationale: e.rationale ?? '' })),
    ),
  } as unknown as CrSpecialistDeps['beliefEdges'];
}

/** Build a fake MemoryRepository stub (returns null for any fetch). */
function fakeMemoryRepo(): CrSpecialistDeps['memoryRepo'] {
  return {
    getMemory: vi.fn().mockResolvedValue(null),
  } as unknown as CrSpecialistDeps['memoryRepo'];
}

// ---------------------------------------------------------------------------
// shouldInvokeCrSpecialist
// ---------------------------------------------------------------------------

describe('shouldInvokeCrSpecialist', () => {
  it('matches "have I ever" phrasing', () => {
    expect(shouldInvokeCrSpecialist('Have I ever used Flask?')).toBe(true);
  });

  it('matches "did I ever" phrasing', () => {
    expect(shouldInvokeCrSpecialist('Did I ever fix the bug?')).toBe(true);
  });

  it('matches "have I already" phrasing', () => {
    expect(shouldInvokeCrSpecialist('Have I already integrated Flask-Login?')).toBe(true);
  });

  it('matches "conflicting" keyword', () => {
    expect(shouldInvokeCrSpecialist('Are these conflicting?')).toBe(true);
  });

  it('matches "contradict" keyword', () => {
    expect(shouldInvokeCrSpecialist('Do these statements contradict each other?')).toBe(true);
  });

  it('does NOT match unrelated questions', () => {
    expect(shouldInvokeCrSpecialist('What is my sprint duration?')).toBe(false);
  });

  it('does NOT match count questions', () => {
    expect(shouldInvokeCrSpecialist('How many users logged in today?')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCrSpecialist
// ---------------------------------------------------------------------------

describe('runCrSpecialist', () => {
  const baseMemories = [
    { id: 'm1', text: 'I implemented Flask routes for the homepage' },
    { id: 'm2', text: 'I have never used Flask in this project' },
  ];

  it('returns handled=false when query does not match CR pattern', async () => {
    const result = await runCrSpecialist({
      memories: baseMemories,
      query: 'What is my sprint duration?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([]),
      memoryRepo: fakeMemoryRepo(),
    });
    expect(result.handled).toBe(false);
    expect(result.answer).toBe('');
  });

  it('returns handled=true with no contradictions when no COUNTER edges found', async () => {
    const result = await runCrSpecialist({
      memories: [{ id: 'm1', text: 'I used Flask' }],
      query: 'Have I ever used Flask?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([]),
      memoryRepo: fakeMemoryRepo(),
    });
    expect(result.handled).toBe(true);
    expect(result.contradictionsFound).toBe(0);
    expect(result.answer).toBe('');
  });

  it('returns handled=true with no contradictions when beliefEdges repo is null (TBC disabled)', async () => {
    const result = await runCrSpecialist({
      memories: [{ id: 'm1', text: 'I used Flask' }],
      query: 'Have I ever used Flask?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: null,
      memoryRepo: fakeMemoryRepo(),
    });
    expect(result.handled).toBe(true);
    expect(result.contradictionsFound).toBe(0);
    expect(result.answer).toBe('');
  });

  it('surfaces both sides of a COUNTER edge via tool-use', async () => {
    (callAnthropicTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      both_sides_present: true,
      answer_text:
        'You said I implemented Flask routes but also I never used Flask. Could you clarify which is correct?',
    });

    const result = await runCrSpecialist({
      memories: baseMemories,
      query: 'Have I ever used Flask?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([{ sourceId: 'm1', targetId: 'm2' }]),
      memoryRepo: fakeMemoryRepo(),
    });

    expect(result.handled).toBe(true);
    expect(result.contradictionsFound).toBe(1);
    expect(result.answer).toContain('You said');
    expect(result.answer).toContain('also');
    expect(result.answer).toContain('correct');
  });

  it('deduplicates symmetric edges (m1->m2 and m2->m1 treated as one pair)', async () => {
    (callAnthropicTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      both_sides_present: true,
      answer_text: 'You said X but also Y. Could you clarify which is correct?',
    });

    const result = await runCrSpecialist({
      memories: baseMemories,
      query: 'Did I ever work with Flask?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([
        { sourceId: 'm1', targetId: 'm2' },
        { sourceId: 'm2', targetId: 'm1' },
      ]),
      memoryRepo: fakeMemoryRepo(),
    });

    expect(result.contradictionsFound).toBe(1);
  });

  it('falls back to memoryRepo.getMemory for sides not in top-K', async () => {
    (callAnthropicTool as ReturnType<typeof vi.fn>).mockResolvedValue({
      both_sides_present: true,
      answer_text: 'You said X but also Y. Could you clarify which is correct?',
    });

    const memoryRepo = {
      getMemory: vi
        .fn()
        .mockResolvedValueOnce({ content: 'I integrated Flask-Login for session management' })
        .mockResolvedValueOnce(null),
    } as unknown as CrSpecialistDeps['memoryRepo'];

    // Only m1 in top-K; m99 must be fetched from DB
    const result = await runCrSpecialist({
      memories: [{ id: 'm1', text: 'I have never used Flask' }],
      query: 'Have I ever integrated Flask-Login?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([{ sourceId: 'm1', targetId: 'm99' }]),
      memoryRepo,
    });

    expect(memoryRepo.getMemory).toHaveBeenCalledWith('m99', 'u1');
    expect(result.contradictionsFound).toBe(1);
  });

  it('skips a pair when one side resolves to empty string', async () => {
    // m99 not in top-K; getMemory returns null → empty string → pair skipped
    const result = await runCrSpecialist({
      memories: [{ id: 'm1', text: 'I used Flask' }],
      query: 'Have I ever used Flask?',
      userId: 'u1',
      model: 'claude-haiku-4-5',
      beliefEdges: fakeBeliefEdges([{ sourceId: 'm1', targetId: 'm99' }]),
      memoryRepo: fakeMemoryRepo(), // always returns null
    });

    expect(result.contradictionsFound).toBe(0);
    expect(result.answer).toBe('');
  });
});
