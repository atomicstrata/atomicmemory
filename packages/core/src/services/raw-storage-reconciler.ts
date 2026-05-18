/**
 * Raw-storage reconciler — promotes `blob_pending` Filecoin
 * rows to `blob_available` once gateway retrievability is confirmed,
 * or marks them `blob_archival_failed` after retry exhaustion.
 *
 * `runOnce(deps)` is the deterministic, side-effect-bounded entry
 * point tests call directly. The scheduler (a separate module) wraps
 * it in a timer-driven loop for production use. NEVER calls
 * setTimeout/setInterval internally — backoff scheduling lives on
 * the row's `raw_storage_next_check_at` column, not in process memory.
 */

import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  RawContentHints,
  RawContentStore,
} from '../storage/raw-content-store.js';
import type {
  InternalRawContentCodecMetadata,
  RawContentCodec,
} from '../storage/raw-content-codec.js';
import { buildLastError } from '../db/raw-document-status-repository.js';
import {
  claimReconcileBatch,
  markStillPendingWithClient,
  type ReconcilerClaimedRow,
} from '../db/raw-storage-reconciliation-repository.js';
import {
  markArchivalFailedAndSyncArtifact,
  promoteAndSyncArtifact,
} from '../db/raw-doc-artifact-sync.js';
import {
  computePendingAgeSeconds,
  emitFilecoinEvent,
} from './filecoin-observability.js';
import { computeBackoffMs } from './raw-storage-reconciler-backoff.js';

export { computeBackoffMs } from './raw-storage-reconciler-backoff.js';

export interface ReconcilerDeps {
  pool: pg.Pool;
  /**
   * Active Filecoin adapter (or any adapter whose capabilities map
   * cleanly onto `head()`-returns-retrievability). The reconciler
   * calls `store.head(storage_uri)` for each claimed row outside
   * any DB tx; in `hash_verify` mode it additionally calls `get()`.
   */
  store: RawContentStore;
  /**
   * Content codec the upload service wrapped around the adapter's
   * `put()`. The reconciler's `hash_verify` mode uses
   * `codec.decode()` to reverse the encoding before sha256-comparing
   * the bytes to the row's `content_hash`. Ignored in `head_only`
   * mode; supplied unconditionally by `createCoreRuntime` so the
   * dep bundle stays the same shape across modes.
   */
  codec: RawContentCodec;
  /**
   * Verification depth before promoting `blob_pending` →
   * `blob_available`:
   *
   *   - `'head_only'`: trust the adapter's `head()` exists-check.
   *     Confirms retrievability but does NOT decode the bytes.
   *   - `'hash_verify'`: after `head()` confirms retrievability,
   *     `get()` the bytes, decode with the active codec, sha256 the
   *     plaintext, and compare to the row's `content_hash`. A
   *     mismatch routes the row to `blob_archival_failed` with
   *     code `content_hash_mismatch`.
   *
   * Runtime config may surface this knob later; the reconciler takes
   * the resolved value directly.
   */
  verifyMode: 'head_only' | 'hash_verify';
  batchSize: number;
  staleAfterMs: number;
  baseIntervalMs: number;
  backoffMaxMs: number;
  maxAttempts: number;
  /**
   * Injectable clock for `pendingAgeSeconds` math. Defaults to `new Date()` in
   * production; tests pass a fixed `Date` so the integration
   * assertions can lock the exact age the event carries instead
   * of a wall-clock range. Pure deterministic substitution; no
   * timing-dependent test logic.
   */
  now?: () => Date;
}

export interface ReconcilerRunSummary {
  claimed: number;
  promoted: number;
  stillPending: number;
  archivalFailed: number;
  lostClaim: number;
}

function clockNow(deps: ReconcilerDeps): Date {
  return deps.now ? deps.now() : new Date();
}

export async function runOnce(deps: ReconcilerDeps): Promise<ReconcilerRunSummary> {
  const claimId = randomUUID();
  const rows = await claimReconcileBatch(deps.pool, {
    claimId,
    batchSize: deps.batchSize,
    staleAfterMs: deps.staleAfterMs,
    provider: deps.store.provider,
  });
  if (rows.length > 0) {
    emitFilecoinEvent('filecoin.reconcile.claimed', {
      provider: deps.store.provider,
      claimId,
      batchSize: rows.length,
    });
  }
  for (const row of rows) {
    if (row.recoveredStaleClaim) {
      emitFilecoinEvent('filecoin.reconcile.stale_claim_recovered', {
        documentId: row.id,
        userId: row.userId,
        provider: row.storageProvider,
        claimId,
        reconcileAttempts: row.rawStorageReconcileAttempts,
        pendingAgeSeconds: computePendingAgeSeconds(row.rawStoragePendingSince, clockNow(deps)) ?? undefined,
      });
    }
  }
  const summary: ReconcilerRunSummary = {
    claimed: rows.length, promoted: 0, stillPending: 0, archivalFailed: 0, lostClaim: 0,
  };
  for (const row of rows) {
    const outcome = await processOneRow(deps, row, claimId);
    if (outcome === 'promoted') summary.promoted += 1;
    else if (outcome === 'still_pending') summary.stillPending += 1;
    else if (outcome === 'archival_failed') summary.archivalFailed += 1;
    else summary.lostClaim += 1;
  }
  return summary;
}

type RowOutcome = 'promoted' | 'still_pending' | 'archival_failed' | 'lost_claim';

async function processOneRow(
  deps: ReconcilerDeps,
  row: ReconcilerClaimedRow,
  claimId: string,
): Promise<RowOutcome> {
  // Hand the row's `raw_storage_metadata` to the adapter so an
  // eventual-consistency provider (Filecoin) can short-circuit
  // its lookup using the provider-specific sidecar it wrote at
  // `put` time (e.g. `data_set_id`). The adapter validates +
  // ignores malformed entries; non-Filecoin adapters ignore the
  // argument entirely.
  const hints = row.rawStorageMetadata as RawContentHints;
  const probe = await probeHead(deps.store, row.storageUri, hints);
  if (probe.kind === 'retrievable') {
    return handleRetrievable(deps, row, claimId, probe);
  }
  if (probe.kind === 'permanent_failure') {
    return archivalFailFromProbe(deps, row, claimId, probe.code, probe.message);
  }
  // Transient/pending outcomes. A late retrievable from a
  // high-attempt-count row must still promote — we never fail on
  // top of a successful probe (rev-7 §7).
  return persistPendingOutcome(deps, row, claimId, probe);
}

/**
 * `retrievable` branch. In `head_only` mode the promotion is
 * unconditional; in `hash_verify` mode we first `get()` the bytes,
 * decode through the codec, sha256 the plaintext, and compare to
 * the row's `content_hash`. Mismatch → permanent failure; transport/
 * decode errors stay transient.
 */
async function handleRetrievable(
  deps: ReconcilerDeps,
  row: ReconcilerClaimedRow,
  claimId: string,
  probe: ProbeRetrievable,
): Promise<RowOutcome> {
  if (deps.verifyMode === 'hash_verify') {
    const verify = await verifyContentHash(deps, row);
    if (verify.kind === 'mismatch') {
      emitFilecoinEvent('filecoin.retrieval.verification_failed', {
        documentId: row.id,
        userId: row.userId,
        provider: row.storageProvider,
        claimId,
        errorCode: 'content_hash_mismatch',
        errorMessage: verify.message,
      });
      return archivalFailFromProbe(deps, row, claimId, 'content_hash_mismatch', verify.message);
    }
    if (verify.kind === 'error') {
      emitFilecoinEvent('filecoin.retrieval.verification_failed', {
        documentId: row.id,
        userId: row.userId,
        provider: row.storageProvider,
        claimId,
        errorCode: 'verify_transport_error',
        errorMessage: verify.message,
      });
      return persistPendingOutcome(deps, row, claimId, { kind: 'error', message: verify.message });
    }
  }
  const rowCount = await promoteAndSyncArtifact(deps.pool, {
    rowId: row.id,
    claimId,
    provider: row.storageProvider,
    providerFields: extractProviderHeadMetadata(row.storageProvider, probe.providerMetadata),
  });
  if (rowCount === 1) {
    emitFilecoinEvent('filecoin.reconcile.promoted', {
      documentId: row.id,
      userId: row.userId,
      provider: row.storageProvider,
      claimId,
      statusBefore: 'blob_pending',
      statusAfter: 'blob_available',
      reconcileAttempts: row.rawStorageReconcileAttempts,
      pendingAgeSeconds: computePendingAgeSeconds(row.rawStoragePendingSince, clockNow(deps)) ?? undefined,
    });
    return 'promoted';
  }
  return 'lost_claim';
}

/**
 * Per-row permanent failure — skip
 * straight to terminal `blob_archival_failed` without burning
 * retries. Caller categorizes the failure (`content_hash_mismatch`,
 * `onramp_reported_failed`, `malformed_storage_uri`, …) via `code`.
 */
async function archivalFailFromProbe(
  deps: ReconcilerDeps,
  row: ReconcilerClaimedRow,
  claimId: string,
  code: string,
  message: string,
): Promise<RowOutcome> {
  const rowCount = await markArchivalFailedAndSyncArtifact(deps.pool, {
    rowId: row.id,
    claimId,
    lastError: buildLastError('raw_storage', code, message) as unknown as Record<string, unknown>,
    provider: row.storageProvider,
  });
  if (rowCount === 1) {
    emitFilecoinEvent('filecoin.reconcile.archival_failed', {
      documentId: row.id,
      userId: row.userId,
      provider: row.storageProvider,
      claimId,
      statusBefore: 'blob_pending',
      statusAfter: 'blob_archival_failed',
      errorCode: code,
      errorMessage: message,
      reconcileAttempts: row.rawStorageReconcileAttempts,
      pendingAgeSeconds: computePendingAgeSeconds(row.rawStoragePendingSince, clockNow(deps)) ?? undefined,
    });
    return 'archival_failed';
  }
  return 'lost_claim';
}

interface VerifyMatch { kind: 'match' }
interface VerifyMismatch { kind: 'mismatch'; message: string }
interface VerifyError { kind: 'error'; message: string }
type VerifyResult = VerifyMatch | VerifyMismatch | VerifyError;

/**
 * `hash_verify` integrity check: `get()` + `decode()` + sha256 +
 * compare against `row.contentHash`. Categorizes failures:
 *
 *   - `'match'`     → bytes decode to the registered plaintext hash.
 *   - `'mismatch'`  → bytes decoded fine but hash disagrees. This
 *     is a per-row terminal failure; the row cannot satisfy the
 *     integrity contract no matter how many retries.
 *   - `'error'`     → transport or decode threw. Likely a global
 *     infra/config problem (gateway 5xx, missing codec key, codec
 *     metadata sidecar absent on the row). Stays transient so a
 *     misconfigured deployment doesn't permanently fail every row.
 *
 * A row with `content_hash === null` is treated as `'error'`: it
 * shouldn't happen for a Phase-5 Filecoin `blob_pending` row (Phase
 * α writes the plaintext hash), and if it does, we want the
 * operator to debug it, not flip the row to terminal.
 */
async function verifyContentHash(
  deps: ReconcilerDeps,
  row: ReconcilerClaimedRow,
): Promise<VerifyResult> {
  if (!row.contentHash) {
    return { kind: 'error', message: 'row has no content_hash; cannot verify' };
  }
  try {
    const got = await deps.store.get(row.storageUri);
    const codecMetadata = extractCodecMetadata(row.rawStorageMetadata);
    const decoded = await deps.codec.decode({ body: got.body, metadata: codecMetadata });
    const observed = sha256Hex(decoded.body);
    if (observed === row.contentHash) return { kind: 'match' };
    return {
      kind: 'mismatch',
      message: `expected content_hash ${row.contentHash}, decoded bytes hash to ${observed}`,
    };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read the codec sidecar the durable URI-write step wrote into `raw_storage_metadata.codec`.
 * Falls back to a `{ name: 'none', version: 1 }` shape so a row missing
 * the sidecar (e.g. legacy / hand-seeded) decodes through the noop
 * path instead of throwing on shape mismatch.
 */
function extractCodecMetadata(
  metadata: Record<string, unknown>,
): InternalRawContentCodecMetadata {
  const codec = metadata['codec'];
  if (codec && typeof codec === 'object' && 'name' in codec && 'version' in codec) {
    return codec as InternalRawContentCodecMetadata;
  }
  return { name: 'none', version: 1 };
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface ProbeRetrievable {
  kind: 'retrievable';
  providerMetadata: Record<string, unknown>;
}

interface ProbePending {
  kind: 'pending';
}

interface ProbeError {
  kind: 'error';
  message: string;
}

interface ProbePermanentFailure {
  kind: 'permanent_failure';
  code: string;
  message: string;
}

type ProbeResult = ProbeRetrievable | ProbePending | ProbeError | ProbePermanentFailure;

async function probeHead(
  store: RawContentStore,
  storageUri: string,
  hints: RawContentHints,
): Promise<ProbeResult> {
  try {
    const result = await store.head(storageUri, hints);
    if (result.exists) {
      const providerMetadata = result.metadata?.providerMetadata ?? {};
      return { kind: 'retrievable', providerMetadata };
    }
    if (result.failure) {
      return {
        kind: 'permanent_failure',
        code: result.failure.code,
        message: result.failure.message,
      };
    }
    return { kind: 'pending' };
  } catch (err) {
    // Thrown errors are transient by default — global infra failures
    // (auth, rate-limit, gateway 5xx) affect every row, and we must
    // NOT flip every pending row to `blob_archival_failed` on a
    // misconfigured deployment. Adapters that want to signal a
    // per-row permanent failure return `{ exists: false, failure }`
    // explicitly.
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pull just the active provider sibling out of the adapter's head
 * metadata. Eventual providers return `{ [provider]: {...} }`;
 * unknown or malformed siblings merge as `{}`.
 */
function extractProviderHeadMetadata(
  provider: string,
  providerMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const providerFields = providerMetadata[provider];
  if (providerFields && typeof providerFields === 'object' && !Array.isArray(providerFields)) {
    return providerFields as Record<string, unknown>;
  }
  return {};
}

async function persistPendingOutcome(
  deps: ReconcilerDeps,
  row: ReconcilerClaimedRow,
  claimId: string,
  probe: ProbePending | ProbeError,
): Promise<RowOutcome> {
  const nextAttempts = row.rawStorageReconcileAttempts + 1;
  if (nextAttempts >= deps.maxAttempts) {
    const code = probe.kind === 'error' ? 'reconcile_probe_error' : 'reconcile_attempts_exhausted';
    const message = probe.kind === 'error'
      ? `probe failed after ${nextAttempts} attempts: ${probe.message}`
      : `pending after ${nextAttempts} reconciliation attempts`;
    return archivalFailFromProbe(deps, row, claimId, code, message);
  }
  const nextCheckAtMs = computeBackoffMs(nextAttempts, deps.baseIntervalMs, deps.backoffMaxMs);
  const rowCount = await markStillPendingWithClient(deps.pool, {
    rowId: row.id, claimId, nextCheckAtMs, provider: row.storageProvider,
  });
  return rowCount === 1 ? 'still_pending' : 'lost_claim';
}
