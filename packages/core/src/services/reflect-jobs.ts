/**
 * Reflect worker. Pulls one pending job at a time from reflection_jobs,
 * marks it in_progress, invokes the Reflect orchestrator, and records the
 * outcome on the job row.
 *
 * Mutations fail closed: if Reflect throws, the job is marked failed with
 * the error message — the loop continues with the next job. The worker never
 * silently swallows errors.
 *
 * Designed for single-instance deployment; multi-instance leasing is out of
 * scope for v1.
 */
import type { ReflectionJobsRepository } from '../db/reflection-jobs-repository.js';
import type { ReflectResult } from './reflect.js';

export interface JobsWorkerDeps {
  jobs: Pick<
    ReflectionJobsRepository,
    'fetchPending' | 'markInProgress' | 'markCompleted' | 'markFailed'
  >;
  runReflect: (userId: string, conversationId: string) => Promise<ReflectResult>;
}

export async function processOnePendingJob(deps: JobsWorkerDeps): Promise<boolean> {
  const [job] = await deps.jobs.fetchPending(1);
  if (!job) return false;

  await deps.jobs.markInProgress(job.id);
  try {
    await deps.runReflect(job.userId, job.conversationId);
    await deps.jobs.markCompleted(job.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await deps.jobs.markFailed(job.id, msg);
  }
  return true;
}

export interface WorkerHandle {
  stop: () => void;
}

export function startReflectWorker(deps: JobsWorkerDeps, pollMs: number): WorkerHandle {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const didWork = await processOnePendingJob(deps);
      if (!didWork) {
        await new Promise(r => setTimeout(r, pollMs));
      }
    } catch (e) {
      console.error('[reflect-worker] unexpected error:', e);
      await new Promise(r => setTimeout(r, pollMs * 2));
    }
    if (!stopped) void tick();
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
