/**
 * Raw-storage reconciler DB layer. The reconciler promotes
 * `raw_storage_status='blob_pending'` rows on eventual providers once the
 * adapter's `head()` confirms gateway retrievability (→
 * `blob_available`) or, after exhausted retries, marks them
 * `blob_archival_failed`.
 *
 * Concurrency model (rev-2 §3 + rev-6 §1): claim-then-release. Phase
 * A grabs a batch in a short transaction with `FOR UPDATE SKIP
 * LOCKED` so multiple reconciler instances partition the work
 * deterministically without coordinator overhead. Slow
 * network calls run with NO DB locks held. failure-transition's per-row UPDATE
 * is guarded on `raw_storage_claim_id` so a stale claim cannot
 * clobber a row another worker has since reclaimed.
 *
 * Eligibility predicate gates on TYPED columns only — no JSONB casts
 * (rev-6 §2): a malformed JSONB shape can't masquerade as a fresh
 * claim. The predicate also explicitly excludes `blob_uploading` rows
 * — those recover through `uploadRaw`'s same-bytes idempotent retry,
 * not the reconciler.
 */

import pg from 'pg';

/** One row's worth of state the reconciler needs to probe + update. */
export interface ReconcilerClaimedRow {
  id: string;
  userId: string;
  storageUri: string;
  storageProvider: string;
  contentHash: string | null;
  rawStorageStatus: 'blob_pending';
  rawStorageMetadata: Record<string, unknown>;
  rawStorageReconcileAttempts: number;
  /**
   * `raw_storage_pending_since` carried through so the reconciler
   * can emit the `pending_age_seconds` observability gauge against
   * the durable lifecycle timestamp (rev-8 §7). NULL only on rows
   * seeded by a path that bypassed the finalization step — production rows always
   * carry it.
   */
  rawStoragePendingSince: Date | null;
  /**
   * True when the claim batch reclaimed a row whose previous
   * `raw_storage_claim_id` was non-NULL (an earlier worker died /
   * crashed). The `filecoin.reconcile.stale_claim_recovered`
   * event uses this to differentiate fresh claims from recoveries.
   */
  recoveredStaleClaim: boolean;
}

export interface ClaimBatchArgs {
  claimId: string;
  batchSize: number;
  staleAfterMs: number;
  provider: string;
}

const RECONCILABLE_PROVIDERS = new Set(['filecoin']);

/**
 * claim step: claim a batch of eligible eventual-provider `blob_pending` rows by
 * writing `raw_storage_claim_id` + `raw_storage_claimed_at`. Skips
 * rows another worker holds a fresh claim on. Returns the typed row
 * state the reconciler will probe; the network call runs after this
 * function returns + the caller commits the transaction.
 *
 * Eligibility predicate (rev-7 §3 — two-axis: claim ownership AND
 * scheduled backoff):
 *   - `raw_storage_status = 'blob_pending'`
 *   - `storage_provider = args.provider`
 *   - `storage_uri IS NOT NULL` (rev-7 §1: the claim step-only rows with no
 *     URI recover via uploadRaw idempotency, NOT the reconciler)
 *   - `deleted_at IS NULL`
 *   - backoff elapsed: `next_check_at IS NULL OR next_check_at <= NOW()`
 *   - no live owner: claim_id NULL OR claimed_at older than staleAfterMs
 */
export async function claimReconcileBatch(
  pool: pg.Pool,
  args: ClaimBatchArgs,
): Promise<ReadonlyArray<ReconcilerClaimedRow>> {
  assertReconciliableProvider(args.provider);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      // Capture the prior `raw_storage_claim_id` in the CTE so the
      // RETURNING clause can flag stale-claim recoveries — RETURNING
      // sees the NEW row only, but joining against the captured CTE
      // (`UPDATE … FROM claimed`) makes the pre-update value
      // visible. The reconciler emits
      // `filecoin.reconcile.stale_claim_recovered` based on this flag.
      `WITH claimed AS (
         SELECT id, raw_storage_claim_id AS prior_claim_id
          FROM raw_documents
          WHERE raw_storage_status = 'blob_pending'
            AND storage_provider = $4
            AND storage_uri IS NOT NULL
            AND deleted_at IS NULL
            AND (raw_storage_next_check_at IS NULL OR raw_storage_next_check_at <= NOW())
            AND (
              raw_storage_claim_id IS NULL
              OR raw_storage_claimed_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
            )
          ORDER BY COALESCE(raw_storage_next_check_at, raw_storage_claimed_at, updated_at) ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE raw_documents rd
          SET raw_storage_claim_id = $3::text,
              raw_storage_claimed_at = NOW(),
              updated_at = NOW()
         FROM claimed
        WHERE rd.id = claimed.id
        RETURNING rd.id, rd.user_id, rd.storage_uri, rd.storage_provider,
                  rd.content_hash, rd.raw_storage_status, rd.raw_storage_metadata,
                  rd.raw_storage_reconcile_attempts, rd.raw_storage_pending_since,
                  (claimed.prior_claim_id IS NOT NULL) AS recovered_stale_claim`,
      [args.staleAfterMs, args.batchSize, args.claimId, args.provider],
    );
    await client.query('COMMIT');
    return result.rows.map(toClaimedRow);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function assertReconciliableProvider(provider: string): void {
  if (!RECONCILABLE_PROVIDERS.has(provider)) {
    throw new Error(`raw-storage reconciler does not support provider '${provider}'`);
  }
}

function toClaimedRow(row: Record<string, unknown>): ReconcilerClaimedRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    storageUri: row.storage_uri as string,
    storageProvider: row.storage_provider as string,
    contentHash: (row.content_hash as string | null) ?? null,
    rawStorageStatus: 'blob_pending',
    rawStorageMetadata:
      (row.raw_storage_metadata as Record<string, unknown> | null) ?? {},
    rawStorageReconcileAttempts:
      typeof row.raw_storage_reconcile_attempts === 'number'
        ? row.raw_storage_reconcile_attempts
        : 0,
    rawStoragePendingSince: parseTimestamp(row.raw_storage_pending_since),
    recoveredStaleClaim: row.recovered_stale_claim === true,
  };
}

function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * failure-transition — success: promote to `blob_available`. Guarded on claim_id
 * + status='blob_pending' so a stale claim cannot promote a row
 * another worker has since failed. Deep-merges the new
 * provider keys into the existing sibling (rev-4 §3) so a status-
 * only probe doesn't drop `cid`/`piece_cid`/`deals` the original
 * upload wrote. Layer-scoped `last_error` clear (rev-4 §2): drops
 * the envelope only when it was scoped to `raw_storage`.
 */
export async function promoteToAvailableWithClient(
  pool: pg.Pool | pg.PoolClient,
  args: {
    rowId: string;
    claimId: string;
    provider: string;
    providerFields: Record<string, unknown>;
  },
): Promise<number> {
  assertReconciliableProvider(args.provider);
  const result = await pool.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'blob_available',
            raw_storage_metadata = raw_storage_metadata ||
              jsonb_build_object(
                $1::text,
                COALESCE(raw_storage_metadata->$1::text, '{}'::jsonb) || $2::jsonb
              ),
            raw_storage_claim_id = NULL,
            raw_storage_claimed_at = NULL,
            raw_storage_last_checked_at = NOW(),
            raw_storage_next_check_at = NULL,
            raw_storage_reconcile_attempts = 0,
            raw_storage_pending_since = NULL,
            last_error = CASE
              WHEN last_error IS NOT NULL AND last_error->>'layer' = 'raw_storage'
              THEN NULL
              ELSE last_error
            END,
            updated_at = NOW()
      WHERE id = $3
        AND raw_storage_status = 'blob_pending'
        AND storage_provider = $1
        AND raw_storage_claim_id = $4`,
    [args.provider, JSON.stringify(args.providerFields), args.rowId, args.claimId],
  );
  return result.rowCount ?? 0;
}

/**
 * failure-transition — still-pending probe: clear the claim (release ownership)
 * + increment attempts + advance `next_check_at` per the
 * caller-computed backoff. Status STAYS `blob_pending` and
 * `pending_since` is preserved.
 */
export async function markStillPendingWithClient(
  pool: pg.Pool,
  args: {
    rowId: string;
    claimId: string;
    nextCheckAtMs: number;
    provider: string;
  },
): Promise<number> {
  assertReconciliableProvider(args.provider);
  const result = await pool.query(
    `UPDATE raw_documents
        SET raw_storage_claim_id = NULL,
            raw_storage_claimed_at = NULL,
            raw_storage_last_checked_at = NOW(),
            raw_storage_next_check_at = NOW() + ($1::bigint * INTERVAL '1 millisecond'),
            raw_storage_reconcile_attempts = raw_storage_reconcile_attempts + 1,
            updated_at = NOW()
      WHERE id = $2
        AND raw_storage_status = 'blob_pending'
        AND storage_provider = $4
        AND raw_storage_claim_id = $3`,
    [args.nextCheckAtMs, args.rowId, args.claimId, args.provider],
  );
  return result.rowCount ?? 0;
}

/**
 * failure-transition — terminal failure: status → `blob_archival_failed`. Sets
 * a fresh raw-storage `last_error` envelope, clears claim/pending
 * state, resets attempts. Guarded on claim_id.
 */
export async function markArchivalFailedWithClient(
  pool: pg.Pool | pg.PoolClient,
  args: {
    rowId: string;
    claimId: string;
    lastError: Record<string, unknown>;
    provider: string;
  },
): Promise<number> {
  assertReconciliableProvider(args.provider);
  const result = await pool.query(
    `UPDATE raw_documents
        SET raw_storage_status = 'blob_archival_failed',
            raw_storage_claim_id = NULL,
            raw_storage_claimed_at = NULL,
            raw_storage_last_checked_at = NOW(),
            raw_storage_next_check_at = NULL,
            raw_storage_reconcile_attempts = 0,
            raw_storage_pending_since = NULL,
            last_error = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2
        AND raw_storage_status = 'blob_pending'
        AND storage_provider = $4
        AND raw_storage_claim_id = $3`,
    [JSON.stringify(args.lastError), args.rowId, args.claimId, args.provider],
  );
  return result.rowCount ?? 0;
}
