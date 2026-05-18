/**
 * Managed-blob upload pipeline for the document registry (the managed-upload
 * α/β/β2/γ split).
 *
 * Atomicity model: the slow `store.put()` no longer runs inside a DB
 * transaction. Instead the pipeline is split into four phases:
 *
 *   - the claim step (short tx, advisory-locked): load the row, run
 *     `classifyIdempotent` against the incoming hash, either short-
 *     circuit (returnExisting) or claim the slot. The claim writes
 *     `raw_storage_status='blob_uploading'` + `raw_storage_claim_id`
 *     + plaintext `content_hash`/`size_bytes`. COMMIT, release lock.
 *   - the provider-write step (no DB locks): `codec.encode()` + `store.put()`. On
 *     throw, mark row `raw_storage_failed` via the per-claim guard.
 *   - the durable URI-write step (short tx): record `storage_uri`/`storage_provider`/
 *     `raw_storage_metadata` durably; status STAYS `blob_uploading`.
 *     Guarded by claim_id; 0-row means another worker reclaimed —
 *     compensate with `store.delete()`.
 *   - the finalization step (short tx): compare-and-set status flip to the final
 *     terminal state via `deriveFinalRawStorageStatus`. Clears claim;
 *     stamps `pending_since` for the observability metric.
 *
 * Same-bytes crash recovery (rev-10 / rev-11):
 *   - blob_uploading WITHOUT URI → reclaimAndUpload (re-run β/β2/γ).
 *   - blob_uploading WITH URI    → finalize (skip β + β2; γ alone).
 *
 * Plaintext source of truth: `content_hash` and `size_bytes` written
 * to the row are the PLAINTEXT hash + length; the encoded-byte hash +
 * encoded size live only under `raw_storage_metadata.codec.*` for ops
 * diagnostics (rev-2 §5).
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type {
  UploadConfig,
  UploadConfigManagedBlob,
} from './upload-config.js';
import { claimUploadSlotWithClient } from '../db/raw-document-blob-repository.js';
import { ArtifactNotLinkableError } from '../db/storage-artifact-repository.js';
import { deriveStorageKeyPrefix } from './storage-key-prefix.js';
import {
  failClaimedUploadAndSyncArtifact,
  finalizeUploadAndSyncArtifact,
  recordUploadResultAndSwapArtifact,
} from './document-upload-artifact-sync.js';
import {
  compensateOrphanedBlob,
  markBeta2FailureOnDocument,
} from './document-upload-beta2-recovery.js';
import { buildLastError } from '../db/raw-document-status-repository.js';
import type { RawDocumentRow } from '../db/raw-document-types.js';
import type { RawContentStore, StoredRawContent } from '../storage/raw-content-store.js';
import type { RawContentCodec } from '../storage/raw-content-codec.js';
import {
  classifyIdempotent,
  deriveFinalRawStorageStatus,
  readPersistedStoredStatus,
  type UploadIdempotencyDecision,
} from './upload-decision.js';
import {
  blobKey,
  buildPhaseBeta2Metadata,
  buildUploadResult,
  describeError,
  idempotentResult,
  loadActive,
  ManagedStorageDisabledError,
  markRawStorageFailureBestEffort,
  sha256Hex,
  UploadClaimLostError,
  UploadDocumentConflictError,
  UploadDocumentNotFoundError,
  type UploadRawInput,
  type UploadRawResult,
} from './upload-helpers.js';
import {
  emitFilecoinEvent,
  sanitizeErrorMessage,
} from './filecoin-observability.js';

export {
  ManagedStorageDisabledError,
  UploadDocumentConflictError,
  UploadDocumentNotFoundError,
  type UploadRawInput,
  type UploadRawResult,
} from './upload-helpers.js';


/**
 * Run the full the managed-upload α/β/β2/γ upload path. Idempotent on
 * byte-identical input. Crash-recoverable: a process death between
 * any two phases is resumable by a same-bytes retry — the claim step's
 * classifyIdempotent decision table picks the right branch.
 */
export async function uploadRawDocument(
  pool: pg.Pool,
  store: RawContentStore | null,
  codec: RawContentCodec,
  cfg: UploadConfig,
  input: UploadRawInput,
): Promise<UploadRawResult> {
  if (cfg.rawStorageMode !== 'managed_blob' || !store) {
    await markRawStorageFailureBestEffort(
      pool, input.userId, input.documentId,
      'managed_storage_disabled',
      'managed_blob storage is not enabled for this deployment',
    );
    throw new ManagedStorageDisabledError();
  }
  const contentHash = sha256Hex(input.body);
  const sizeBytes = input.body.length;
  // upload-observability — drives `upload_latency_seconds` aggregation. The
  // event taxonomy is `filecoin.upload.*` so we only emit when the
  // active adapter is Filecoin storage. local_fs / s3 uploads
  // produce no `[FILECOIN]` events.
  const isFilecoin = store.provider === 'filecoin';
  const startedAt = Date.now();
  if (isFilecoin) {
    emitFilecoinEvent('filecoin.upload.started', {
      documentId: input.documentId,
      userId: input.userId,
    });
  }

  return runUploadPhases(pool, store, codec, cfg, contentHash, sizeBytes, input, {
    startedAt, isFilecoin,
  });
}

async function runUploadPhases(
  pool: pg.Pool,
  store: RawContentStore,
  codec: RawContentCodec,
  cfg: UploadConfigManagedBlob,
  contentHash: string,
  sizeBytes: number,
  input: UploadRawInput,
  obs: { startedAt: number; isFilecoin: boolean },
): Promise<UploadRawResult> {
  try {
    const alpha = await runPhaseAlpha(pool, contentHash, sizeBytes, input);
    const result =
      alpha.kind === 'returnExisting'
        ? alpha.result
        : alpha.kind === 'finalize'
          ? await runPhaseGammaOnly(pool, alpha, input)
          : await runPhaseBetaThroughGamma(pool, store, codec, cfg, alpha, input);
    if (obs.isFilecoin) {
      emitFilecoinEvent('filecoin.upload.accepted', {
        documentId: input.documentId,
        userId: input.userId,
        provider: result.storageProvider ?? undefined,
        statusAfter: result.rawStorageStatus,
        durationMs: Date.now() - obs.startedAt,
      });
    }
    return result;
  } catch (err) {
    if (obs.isFilecoin) {
      emitFilecoinEvent('filecoin.upload.failed', {
        documentId: input.documentId,
        userId: input.userId,
        errorCode: extractUploadErrorCode(err),
        errorMessage: sanitizeErrorMessage(err),
        durationMs: Date.now() - obs.startedAt,
      });
    }
    throw err;
  }
}

function extractUploadErrorCode(err: unknown): string {
  if (err instanceof Error) {
    const candidate = (err as unknown as { code?: unknown }).code;
    if (typeof candidate === 'string') return candidate;
    if (err.name === 'UploadDocumentConflictError') return 'document_conflict';
    if (err.name === 'UploadDocumentNotFoundError') return 'document_not_found';
    if (err.name === 'UploadClaimLostError') return 'upload_claim_lost';
    if (err.name === 'ManagedStorageDisabledError') return 'managed_storage_disabled';
  }
  return 'unknown';
}

interface AlphaClaimed {
  kind: 'reclaimAndUpload' | 'finalize';
  claimId: string;
  document: RawDocumentRow;
  contentHash: string;
  sizeBytes: number;
}

interface AlphaShortCircuit {
  kind: 'returnExisting';
  result: UploadRawResult;
}

async function runPhaseAlpha(
  pool: pg.Pool,
  contentHash: string,
  sizeBytes: number,
  input: UploadRawInput,
): Promise<AlphaClaimed | AlphaShortCircuit> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.documentId]);
    const document = await loadActive(client, input);
    const decision = classifyIdempotent(document, contentHash);
    const earlyReturn = checkPhaseAlphaEarlyExit(document, contentHash, sizeBytes, decision);
    if (earlyReturn) {
      await client.query('COMMIT');
      if (earlyReturn.kind === 'throw') throw earlyReturn.err;
      return earlyReturn.result;
    }
    return await commitPhaseAlphaClaim(client, document, contentHash, sizeBytes, decision, input);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type PhaseAlphaEarlyExit =
  | { kind: 'return'; result: AlphaShortCircuit }
  | { kind: 'throw'; err: UploadDocumentConflictError };

function checkPhaseAlphaEarlyExit(
  document: RawDocumentRow,
  contentHash: string,
  sizeBytes: number,
  decision: UploadIdempotencyDecision | null,
): PhaseAlphaEarlyExit | null {
  if (decision?.kind === 'returnExisting') {
    return {
      kind: 'return',
      result: { kind: 'returnExisting', result: idempotentResult(document, contentHash, sizeBytes) },
    };
  }
  if (decision === null && hasConflictingManagedBlob(document, contentHash)) {
    return {
      kind: 'throw',
      err: new UploadDocumentConflictError(document.id, document.contentHash ?? '', contentHash),
    };
  }
  return null;
}

async function commitPhaseAlphaClaim(
  client: pg.PoolClient,
  document: RawDocumentRow,
  contentHash: string,
  sizeBytes: number,
  decision: UploadIdempotencyDecision | null,
  input: UploadRawInput,
): Promise<AlphaClaimed> {
  // `checkPhaseAlphaEarlyExit` already handled returnExisting +
  // conflict; what reaches us is reclaimAndUpload / finalize / null.
  const branch: AlphaClaimed['kind'] =
    decision?.kind === 'finalize' ? 'finalize' : 'reclaimAndUpload';
  // Finalize preserves the durable URI (the bytes are already on the
  // provider); reclaim/fresh clear it so a crash before the durable URI-write step can't
  // strand the row in a finalize-recovery window pointing at stale
  // bytes (rev-fix HIGH 2).
  const claimId = randomUUID();
  const claimed = await claimUploadSlotWithClient(client, {
    userId: input.userId, documentId: input.documentId, claimId, contentHash, sizeBytes,
    clearDurableUri: branch === 'reclaimAndUpload',
  });
  if (claimed === 0) {
    await client.query('COMMIT');
    throw new UploadDocumentNotFoundError(input.documentId);
  }
  await client.query('COMMIT');
  return { kind: branch, claimId, document, contentHash, sizeBytes };
}

async function runPhaseBetaThroughGamma(
  pool: pg.Pool,
  store: RawContentStore,
  codec: RawContentCodec,
  cfg: UploadConfigManagedBlob,
  alpha: AlphaClaimed,
  input: UploadRawInput,
): Promise<UploadRawResult> {
  const stored = await runPhaseBeta(pool, store, codec, cfg, alpha, input);
  await runPhaseBeta2(pool, store, alpha, stored);
  return runPhaseGammaFromStored(pool, alpha, stored, input);
}

async function runPhaseBeta(
  pool: pg.Pool,
  store: RawContentStore,
  codec: RawContentCodec,
  cfg: UploadConfigManagedBlob,
  alpha: AlphaClaimed,
  input: UploadRawInput,
): Promise<StoredRawContent & { codecMetadata: Record<string, unknown> }> {
  try {
    const encoded = await codec.encode({ body: input.body });
    const userPrefix = deriveStorageKeyPrefix(cfg.storageKeyHmacSecret, input.userId);
    const stored = await store.put({
      key: blobKey(cfg.rawStoragePrefix, userPrefix, input.documentId, alpha.contentHash),
      body: encoded.body,
      contentType: input.contentType,
    });
    return { ...stored, codecMetadata: encoded.metadata as unknown as Record<string, unknown> };
  } catch (err) {
    const lastError = buildLastError(
      'raw_storage',
      'transport_error',
      describeError(err),
    ) as unknown as Record<string, unknown>;
    // the paired artifact-sync implementation paired the provider-write step failure: flip raw_storage_status AND
    // sync the linked artifact to 'failed' in one transaction so
    // the two rows never diverge across a failed store.put().
    //
    // Marker failures used to swallow the inner error silently; we
    // now log with context so a follow-up worker can see that the
    // claim cleanup itself failed (the outer throw still wins so
    // the upload pipeline surfaces the original store.put error).
    try {
      await failClaimedUploadAndSyncArtifact(pool, {
        userId: input.userId,
        documentId: input.documentId,
        claimId: alpha.claimId,
        lastError,
      });
    } catch (markerErr) {
      // eslint-disable-next-line no-console
      console.error(
        `runPhaseBeta: failed to mark raw_storage_failed + sync artifact for ` +
          `document ${input.documentId} after store.put error: ${describeError(markerErr)}`,
      );
    }
    throw err;
  }
}

async function runPhaseBeta2(
  pool: pg.Pool,
  store: RawContentStore,
  alpha: AlphaClaimed,
  stored: StoredRawContent & { codecMetadata: Record<string, unknown> },
): Promise<void> {
  const metadata = buildPhaseBeta2Metadata(stored);
  // the paired artifact-sync implementation paired the durable URI-write step: URI write + artifact swap commit
  // together. Two failure modes after `store.put` has durably
  // written bytes:
  //
  //   1. `rowCount === 0` — the upload claim was lost (another
  //      worker reclaimed the row). The artifact swap helper
  //      rolled back; we compensate by deleting the bytes we
  //      wrote and throw `UploadClaimLostError`. The raw_document
  //      is now owned by the new worker so we DO NOT write to its
  //      `last_error`.
  //   2. The swap helper THROWS (e.g. `ArtifactNotLinkableError`
  //      when the prior artifact entered a delete lifecycle
  //      between our claim and the swap). Without explicit
  //      compensation the bytes would orphan. We catch every
  //      throw, attempt provider cleanup, AND flip the doc's
  //      `raw_storage_status` to `raw_storage_failed` with a
  //      typed `artifact_not_linkable` envelope so the public
  //      status surfaces stop saying "upload in progress" for a
  //      doc whose upload actually failed.
  //
  // The cleanup `store.delete` call is best-effort. When it fails
  // the orphan URI + provider are embedded in the raw_document's
  // `last_error.internal_recovery_hint` (wire-stripped by the
  // response formatter) so a reconciler / ops can find the
  // abandoned bytes later.
  let result: { rowCount: number };
  try {
    result = await recordUploadResultAndSwapArtifact(pool, {
      userId: alpha.document.userId,
      documentId: alpha.document.id,
      claimId: alpha.claimId,
      storageUri: stored.storageUri,
      storageProvider: stored.storageProvider,
      rawStorageMetadata: metadata,
      document: alpha.document,
      contentHash: alpha.contentHash,
      stored,
    });
  } catch (err) {
    const compensation = await compensateOrphanedBlob(store, stored.storageUri, alpha.document.id, err);
    await markBeta2FailureOnDocument({
      pool, document: alpha.document, claimId: alpha.claimId, stored,
      reasonCode: err instanceof ArtifactNotLinkableError ? 'artifact_not_linkable' : 'beta2_swap_failed',
      reasonMessage: describeError(err),
      compensation,
    });
    throw err;
  }
  if (result.rowCount === 0) {
    // Lost-claim path: another worker now owns the row's lifecycle.
    // Compensate the orphan bytes if we can, but DO NOT write to
    // the row's `last_error` — that belongs to the new claim. The
    // structured log event below carries the orphan info when
    // cleanup fails (best we can do without clobbering the new
    // claim's state).
    await compensateOrphanedBlob(
      store, stored.storageUri, alpha.document.id,
      new UploadClaimLostError(alpha.document.id, alpha.claimId, 'beta2'),
    );
    throw new UploadClaimLostError(alpha.document.id, alpha.claimId, 'beta2');
  }
}

async function runPhaseGammaFromStored(
  pool: pg.Pool,
  alpha: AlphaClaimed,
  stored: StoredRawContent & { codecMetadata: Record<string, unknown> },
  input: UploadRawInput,
): Promise<UploadRawResult> {
  const finalStatus = deriveFinalRawStorageStatus({
    storedStatus: stored.status,
    storageProvider: stored.storageProvider,
  });
  const rowCount = await finalizeUploadAndSyncArtifact(pool, {
    userId: input.userId, documentId: input.documentId,
    claimId: alpha.claimId, finalStatus,
  });
  if (rowCount === 0) {
    throw new UploadClaimLostError(input.documentId, alpha.claimId, 'gamma');
  }
  return buildUploadResult({
    documentId: alpha.document.id,
    storageProvider: stored.storageProvider,
    storageUri: stored.storageUri,
    contentHash: alpha.contentHash,
    sizeBytes: alpha.sizeBytes,
    finalStatus,
    rawStorageMetadata: buildPhaseBeta2Metadata(stored),
    idempotentSkip: false,
  });
}

async function runPhaseGammaOnly(
  pool: pg.Pool,
  alpha: AlphaClaimed,
  input: UploadRawInput,
): Promise<UploadRawResult> {
  const storedStatus = readPersistedStoredStatus(alpha.document.rawStorageMetadata);
  if (storedStatus === null) {
    throw new Error(
      `the finalization step finalize-recovery: row ${input.documentId} has blob_uploading + storage_uri but ` +
        'no raw_storage_metadata.upload_result.stored_status sidecar (the durable URI-write step incomplete?)',
    );
  }
  const storageProvider = alpha.document.storageProvider;
  if (!storageProvider) {
    throw new Error(
      `the finalization step finalize-recovery: row ${input.documentId} has no storage_provider despite a durable URI`,
    );
  }
  const finalStatus = deriveFinalRawStorageStatus({ storedStatus, storageProvider });
  const rowCount = await finalizeUploadAndSyncArtifact(pool, {
    userId: input.userId, documentId: input.documentId,
    claimId: alpha.claimId, finalStatus,
  });
  if (rowCount === 0) {
    throw new UploadClaimLostError(input.documentId, alpha.claimId, 'gamma');
  }
  return buildUploadResult({
    documentId: alpha.document.id,
    storageProvider,
    storageUri: alpha.document.storageUri!,
    contentHash: alpha.contentHash,
    sizeBytes: alpha.sizeBytes,
    finalStatus,
    rawStorageMetadata: alpha.document.rawStorageMetadata,
    idempotentSkip: false,
  });
}

function isManagedBlobOccupied(status: RawDocumentRow['rawStorageStatus']): boolean {
  return status === 'blob_stored'
    || status === 'blob_pending'
    || status === 'blob_available'
    || status === 'blob_uploading';
}

/**
 * Conflict guard: fires on any occupied managed_blob state where the
 * incoming hash disagrees with the persisted plaintext hash. Crucially
 * does NOT require `storage_uri !== null` — a `blob_uploading` row
 * whose the claim step recorded the plaintext hash but whose the durable URI-write step hasn't
 * yet written the URI still owns the slot, and a different-hash
 * caller arriving in that window must 409 (rev-fix HIGH 1).
 */
function hasConflictingManagedBlob(document: RawDocumentRow, contentHash: string): boolean {
  return (
    isManagedBlobOccupied(document.rawStorageStatus)
    && document.contentHash !== null
    && document.contentHash !== contentHash
  );
}
