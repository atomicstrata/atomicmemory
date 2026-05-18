/**
 * Integration tests for ReflectionJobsRepository. Uses the .env.test
 * Postgres instance; assumes the 20260512_session_reflections migration
 * has been applied (via `npm run migrate:test`).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ReflectionJobsRepository } from '../reflection-jobs-repository.js';
import { config } from '../../config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const repo = new ReflectionJobsRepository(pool);

afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query("DELETE FROM reflection_jobs WHERE user_id LIKE 'test-rjq-%'");
});

const USER = 'test-rjq-1';
const CONV = 'conv-A';

describe('ReflectionJobsRepository', () => {
  it('enqueue creates a pending job', async () => {
    await repo.enqueue(USER, CONV);
    const ready = await repo.fetchPending(10);
    expect(ready).toHaveLength(1);
    expect(ready[0].status).toBe('pending');
    expect(ready[0].userId).toBe(USER);
  });

  it('enqueue is idempotent per (userId, conversationId) while pending or in_progress', async () => {
    await repo.enqueue(USER, CONV);
    await repo.enqueue(USER, CONV);
    const ready = await repo.fetchPending(10);
    expect(ready).toHaveLength(1);
  });

  it('markInProgress / markCompleted / markFailed flow', async () => {
    await repo.enqueue(USER, CONV);
    const [job] = await repo.fetchPending(10);
    await repo.markInProgress(job.id);
    let row = await repo.findById(job.id);
    expect(row?.status).toBe('in_progress');
    await repo.markCompleted(job.id);
    row = await repo.findById(job.id);
    expect(row?.status).toBe('completed');

    await repo.enqueue(USER, 'conv-B');
    const [other] = await repo.fetchPending(10);
    await repo.markFailed(other.id, 'boom');
    row = await repo.findById(other.id);
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toBe('boom');
  });

  it('after completion, enqueue for same (user, conv) creates a new job', async () => {
    await repo.enqueue(USER, CONV);
    const [j] = await repo.fetchPending(10);
    await repo.markInProgress(j.id);
    await repo.markCompleted(j.id);
    await repo.enqueue(USER, CONV);
    const again = await repo.fetchPending(10);
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(j.id);
  });
});
