/**
 * Durable Postgres outbox for Cloud trace upload.
 */

import type pg from 'pg';
import type { CloudTraceEnvelopeV2 } from '../services/cloud-trace-envelope.js';

export type CloudTraceDeliveryState = 'pending' | 'claimed' | 'sent' | 'dead_letter';

export interface CloudTraceOutboxRow {
  eventId: string;
  schemaVersion: number;
  payload: CloudTraceEnvelopeV2;
  deliveryState: CloudTraceDeliveryState;
  attemptCount: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  sentAt: Date | null;
  deadLetterAt: Date | null;
}

export async function enqueueCloudTraceOutbox(
  pool: pg.Pool,
  envelope: CloudTraceEnvelopeV2,
): Promise<void> {
  await pool.query(
    `INSERT INTO cloud_trace_outbox (event_id, schema_version, payload, delivery_state)
     VALUES ($1, $2, $3::jsonb, 'pending')
     ON CONFLICT (event_id) DO NOTHING`,
    [envelope.event_id, envelope.schema_version, JSON.stringify(envelope)],
  );
}

export async function claimCloudTraceBatch(
  pool: pg.Pool,
  limit: number,
  staleAfterMs: number,
): Promise<CloudTraceOutboxRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT event_id, schema_version, payload, delivery_state, attempt_count,
              next_attempt_at, last_error_code, created_at, claimed_at, sent_at, dead_letter_at
         FROM cloud_trace_outbox
        WHERE (
                delivery_state = 'pending'
                AND next_attempt_at <= now()
              )
           OR (
                delivery_state = 'claimed'
                AND claimed_at < now() - ($2::bigint * interval '1 millisecond')
              )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit, staleAfterMs],
    );
    const ids = result.rows.map((row) => row.event_id as string);
    if (ids.length > 0) {
      await client.query(
        `UPDATE cloud_trace_outbox
            SET delivery_state = 'claimed', claimed_at = now()
          WHERE event_id = ANY($1::uuid[])`,
        [ids],
      );
    }
    await client.query('COMMIT');
    return result.rows.map(mapRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markCloudTraceSent(pool: pg.Pool, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE cloud_trace_outbox
        SET delivery_state = 'sent', sent_at = now(), last_error_code = NULL
      WHERE event_id = $1`,
    [eventId],
  );
}

export async function scheduleCloudTraceRetry(
  pool: pg.Pool,
  eventId: string,
  errorCode: string,
  nextAttemptAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE cloud_trace_outbox
        SET delivery_state = 'pending',
            attempt_count = attempt_count + 1,
            next_attempt_at = $2,
            last_error_code = $3,
            claimed_at = NULL
      WHERE event_id = $1`,
    [eventId, nextAttemptAt, errorCode],
  );
}

export async function countPendingCloudTraces(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM cloud_trace_outbox
      WHERE delivery_state IN ('pending', 'claimed')`,
  );
  return result.rows[0]?.count ?? 0;
}

export async function countDeadLetterCloudTraces(pool: pg.Pool): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM cloud_trace_outbox
      WHERE delivery_state = 'dead_letter'`,
  );
  return result.rows[0]?.count ?? 0;
}

export async function getOldestPendingCloudTraceAgeMs(pool: pg.Pool): Promise<number | null> {
  const result = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000 AS age_ms
       FROM cloud_trace_outbox
      WHERE delivery_state IN ('pending', 'claimed')`,
  );
  const age = result.rows[0]?.age_ms;
  if (age == null) return null;
  const parsed = Number(age);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export async function markCloudTraceDeadLetter(
  pool: pg.Pool,
  eventId: string,
  errorCode: string,
): Promise<void> {
  await pool.query(
    `UPDATE cloud_trace_outbox
        SET delivery_state = 'dead_letter',
            dead_letter_at = now(),
            last_error_code = $2,
            claimed_at = NULL
      WHERE event_id = $1`,
    [eventId, errorCode],
  );
}

export async function purgeSentCloudTraces(pool: pg.Pool, retentionMs: number): Promise<void> {
  await pool.query(
    `DELETE FROM cloud_trace_outbox
      WHERE delivery_state = 'sent'
        AND sent_at IS NOT NULL
        AND sent_at < now() - ($1::bigint * interval '1 millisecond')`,
    [retentionMs],
  );
}

export async function purgeDeadLetterCloudTraces(pool: pg.Pool, retentionMs: number): Promise<void> {
  await pool.query(
    `DELETE FROM cloud_trace_outbox
      WHERE delivery_state = 'dead_letter'
        AND dead_letter_at IS NOT NULL
        AND dead_letter_at < now() - ($1::bigint * interval '1 millisecond')`,
    [retentionMs],
  );
}

function mapRow(row: pg.QueryResultRow): CloudTraceOutboxRow {
  return {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    payload: row.payload as CloudTraceEnvelopeV2,
    deliveryState: row.delivery_state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    sentAt: row.sent_at,
    deadLetterAt: row.dead_letter_at,
  };
}
