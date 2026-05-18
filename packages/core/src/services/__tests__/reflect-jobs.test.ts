import { describe, expect, it, vi } from 'vitest';
import { processOnePendingJob, type JobsWorkerDeps } from '../reflect-jobs.js';

const baseDeps = (): JobsWorkerDeps => ({
  jobs: {
    fetchPending: vi.fn(),
    markInProgress: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  } as any,
  runReflect: vi.fn().mockResolvedValue({ count: 3 }),
});

describe('processOnePendingJob', () => {
  it('returns false when no pending job available', async () => {
    const deps = baseDeps();
    (deps.jobs.fetchPending as any).mockResolvedValue([]);
    const did = await processOnePendingJob(deps);
    expect(did).toBe(false);
    expect(deps.runReflect).not.toHaveBeenCalled();
  });

  it('marks in_progress, runs reflect, marks completed on success', async () => {
    const deps = baseDeps();
    (deps.jobs.fetchPending as any).mockResolvedValue([
      { id: 'j1', userId: 'u', conversationId: 'c' },
    ]);
    const did = await processOnePendingJob(deps);
    expect(did).toBe(true);
    expect(deps.jobs.markInProgress).toHaveBeenCalledWith('j1');
    expect(deps.runReflect).toHaveBeenCalledWith('u', 'c');
    expect(deps.jobs.markCompleted).toHaveBeenCalledWith('j1');
    expect(deps.jobs.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed when runReflect throws', async () => {
    const deps = baseDeps();
    (deps.jobs.fetchPending as any).mockResolvedValue([
      { id: 'j2', userId: 'u', conversationId: 'c' },
    ]);
    (deps.runReflect as any).mockRejectedValue(new Error('boom'));
    const did = await processOnePendingJob(deps);
    expect(did).toBe(true);
    expect(deps.jobs.markFailed).toHaveBeenCalledWith('j2', expect.stringContaining('boom'));
    expect(deps.jobs.markCompleted).not.toHaveBeenCalled();
  });
});
