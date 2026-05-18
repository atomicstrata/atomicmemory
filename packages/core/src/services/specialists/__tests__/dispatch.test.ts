/**
 * Unit tests for the Phase 2 specialist dispatcher.
 *
 * Verifies priority order, short-circuit behaviour on handled=true,
 * fall-through on handled=false, and the final none sentinel.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { dispatchSpecialists, type SpecialistDispatchDeps } from '../dispatch.js';

// Mock all four specialist modules before importing dispatch
vi.mock('../cr-specialist.js', () => ({
  shouldInvokeCrSpecialist: vi.fn(),
  runCrSpecialist: vi.fn(),
}));
vi.mock('../msr-specialist.js', () => ({
  shouldInvokeMsrSpecialist: vi.fn(),
  runMsrSpecialist: vi.fn(),
}));
vi.mock('../tr-specialist.js', () => ({
  shouldInvokeTrSpecialist: vi.fn(),
  runTrSpecialist: vi.fn(),
}));
vi.mock('../ie-ku-specialist.js', () => ({
  shouldInvokeIeKuSpecialist: vi.fn(),
  runIeKuSpecialist: vi.fn(),
}));

import { shouldInvokeCrSpecialist, runCrSpecialist } from '../cr-specialist.js';
import { shouldInvokeMsrSpecialist, runMsrSpecialist } from '../msr-specialist.js';
import { shouldInvokeTrSpecialist, runTrSpecialist } from '../tr-specialist.js';
import { shouldInvokeIeKuSpecialist, runIeKuSpecialist } from '../ie-ku-specialist.js';

/** Stub repositories — only the types matter for dispatch logic. */
const stubBeliefEdges = {} as SpecialistDispatchDeps['beliefEdges'];
const stubMemoryRepo = {} as SpecialistDispatchDeps['memoryRepo'];
const stubEntityValues = {} as NonNullable<SpecialistDispatchDeps['entityValues']>;

const baseDeps: SpecialistDispatchDeps = {
  memories: [{ id: 'm1', text: 'some fact' }],
  query: 'test query',
  userId: 'u1',
  model: 'claude-haiku-4-5',
  beliefEdges: stubBeliefEdges,
  memoryRepo: stubMemoryRepo,
  entityValues: stubEntityValues,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no specialist matches
  vi.mocked(shouldInvokeCrSpecialist).mockReturnValue(false);
  vi.mocked(shouldInvokeMsrSpecialist).mockReturnValue(false);
  vi.mocked(shouldInvokeTrSpecialist).mockReturnValue(false);
  vi.mocked(shouldInvokeIeKuSpecialist).mockReturnValue(false);
});

describe('dispatchSpecialists', () => {
  it('returns handled=false and specialist=none when all specialists miss', async () => {
    const result = await dispatchSpecialists(baseDeps);
    expect(result.handled).toBe(false);
    expect(result.answer).toBe('');
    expect(result.specialist).toBe('none');
    expect(runCrSpecialist).not.toHaveBeenCalled();
    expect(runMsrSpecialist).not.toHaveBeenCalled();
    expect(runTrSpecialist).not.toHaveBeenCalled();
    expect(runIeKuSpecialist).not.toHaveBeenCalled();
  });

  it('returns CR result and does not call later specialists when CR matches first', async () => {
    vi.mocked(shouldInvokeCrSpecialist).mockReturnValue(true);
    vi.mocked(runCrSpecialist).mockResolvedValue({
      handled: true,
      answer: 'You said X but also Y.',
      contradictionsFound: 1,
    });

    const result = await dispatchSpecialists(baseDeps);

    expect(result.handled).toBe(true);
    expect(result.specialist).toBe('cr');
    expect(result.answer).toBe('You said X but also Y.');
    expect(runMsrSpecialist).not.toHaveBeenCalled();
    expect(runTrSpecialist).not.toHaveBeenCalled();
    expect(runIeKuSpecialist).not.toHaveBeenCalled();
  });

  it('falls through to MSR when CR returns handled=false', async () => {
    vi.mocked(shouldInvokeCrSpecialist).mockReturnValue(true);
    vi.mocked(runCrSpecialist).mockResolvedValue({
      handled: false,
      answer: '',
      contradictionsFound: 0,
    });
    vi.mocked(shouldInvokeMsrSpecialist).mockReturnValue(true);
    vi.mocked(runMsrSpecialist).mockResolvedValue({
      handled: true,
      answer: '3: a, b, c.',
      items: ['a', 'b', 'c'],
      usedLlm: false,
    });

    const result = await dispatchSpecialists(baseDeps);

    expect(result.handled).toBe(true);
    expect(result.specialist).toBe('msr');
    expect(result.answer).toBe('3: a, b, c.');
  });

  it('TR wins over MSR on overlapping "how many days between" query', async () => {
    // Both MSR and TR match, but TR is checked first in the priority chain
    vi.mocked(shouldInvokeCrSpecialist).mockReturnValue(false);
    vi.mocked(shouldInvokeTrSpecialist).mockReturnValue(true);
    vi.mocked(shouldInvokeMsrSpecialist).mockReturnValue(true);
    vi.mocked(runTrSpecialist).mockResolvedValue({
      handled: true,
      answer: '21 days between event A and event B.',
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-01-22'),
      durationDays: 21,
      usedLlm: false,
    });

    const result = await dispatchSpecialists({ ...baseDeps, query: 'How many days between sprint start and demo?' });

    expect(result.handled).toBe(true);
    expect(result.specialist).toBe('tr');
    // MSR must not be called — TR short-circuited
    expect(runMsrSpecialist).not.toHaveBeenCalled();
  });

  it('IE/KU specialist runs when no earlier specialist matches', async () => {
    vi.mocked(shouldInvokeIeKuSpecialist).mockReturnValue(true);
    vi.mocked(runIeKuSpecialist).mockResolvedValue({
      handled: true,
      answer: '1,200 calls per day',
      matchedEntity: 'API key',
      matchedAttribute: 'daily quota',
    });

    const result = await dispatchSpecialists({ ...baseDeps, query: "What is the API key's daily quota?" });

    expect(result.handled).toBe(true);
    expect(result.specialist).toBe('ie_ku');
    expect(result.answer).toBe('1,200 calls per day');
    expect(runCrSpecialist).not.toHaveBeenCalled();
    expect(runMsrSpecialist).not.toHaveBeenCalled();
    expect(runTrSpecialist).not.toHaveBeenCalled();
  });
});
