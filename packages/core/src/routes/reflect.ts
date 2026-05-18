/**
 * Synchronous reflect-flush endpoint for benchmark / eval mode.
 *
 * POST /v1/reflect/flush — drains all pending reflection_jobs serially and
 * returns the count of jobs processed. Returns 503 if Reflect is disabled.
 *
 * This endpoint is intentionally synchronous (it blocks until the queue is
 * empty or the 1 000-job safety cap is hit) so benchmarking harnesses can
 * call it once after ingest and be guaranteed all reflections are written
 * before issuing queries.
 */
import type { Request, Response } from 'express';
import type { JobsWorkerDeps } from '../services/reflect-jobs.js';
import { processOnePendingJob } from '../services/reflect-jobs.js';

const FLUSH_JOB_CAP = 1000;

export function makeReflectFlushHandler(
  deps: JobsWorkerDeps,
  enabled: boolean,
): (req: Request, res: Response) => Promise<void> {
  return async (_req, res) => {
    if (!enabled) {
      res.status(503).json({ error: 'reflect_disabled' });
      return;
    }
    let processed = 0;
    let remaining = FLUSH_JOB_CAP;
    while (remaining-- > 0) {
      const did = await processOnePendingJob(deps);
      if (!did) break;
      processed++;
    }
    res.json({ processed });
  };
}
