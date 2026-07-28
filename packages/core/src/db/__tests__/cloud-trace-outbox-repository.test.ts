/**
 * Integration tests for Cloud trace outbox repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../pool.js';
import { setupTestSchema } from './test-fixtures.js';
import {
  claimCloudTraceBatch,
  countPendingCloudTraces,
  enqueueCloudTraceOutbox,
  markCloudTraceSent,
} from '../cloud-trace-outbox-repository.js';
import { buildCloudTraceEnvelope } from '../../services/cloud-trace-envelope.js';

function sampleEnvelope(eventId: string = randomUUID()) {
  return buildCloudTraceEnvelope({
    eventId,
    coreInstanceId: 'core-test-1',
    occurredAt: '2026-07-10T16:00:00Z',
    operation: 'memory.ingest',
    outcome: 'success',
    durationMs: 1,
    summary: { user_id: 'test-user', operation_detail: 'test ingest' },
  });
}

beforeAll(async () => {
  await setupTestSchema(pool);
});

beforeEach(async () => {
  await pool.query('DELETE FROM cloud_trace_outbox');
});

afterAll(async () => {
  await pool.end();
});

describe('cloud trace outbox repository', () => {
  it('enqueue and claim a pending row', async () => {
    const envelope = sampleEnvelope();
    await enqueueCloudTraceOutbox(pool, envelope);
    const claimed = await claimCloudTraceBatch(pool, 10, 300_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.eventId).toBe(envelope.event_id);
    const state = await pool.query(
      `SELECT delivery_state FROM cloud_trace_outbox WHERE event_id = $1`,
      [envelope.event_id],
    );
    expect(state.rows[0]?.delivery_state).toBe('claimed');
  });

  it('reclaims stale claimed rows after crash', async () => {
    const envelope = sampleEnvelope();
    await enqueueCloudTraceOutbox(pool, envelope);
    const first = await claimCloudTraceBatch(pool, 10, 300_000);
    expect(first).toHaveLength(1);

    await pool.query(
      `UPDATE cloud_trace_outbox
          SET claimed_at = now() - interval '10 minutes'
        WHERE event_id = $1`,
      [envelope.event_id],
    );

    const reclaimed = await claimCloudTraceBatch(pool, 10, 60_000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.eventId).toBe(envelope.event_id);

    await markCloudTraceSent(pool, envelope.event_id);
    expect(await countPendingCloudTraces(pool)).toBe(0);
  });
});
