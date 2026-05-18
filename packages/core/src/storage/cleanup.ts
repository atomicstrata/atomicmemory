/**
 * Managed-blob cleanup helper (raw-content + per-row provider dispatch).
 *
 * Every code path that soft- or hard-deletes a `raw_documents` row
 * backed by `storage_mode='managed_blob'` runs the collected
 * `(storage_provider, storage_uri)` tuples through this helper *after*
 * the DB transaction commits.
 *
 * per-row provider dispatch changes: cleanup dispatches per `blob.storageProvider` via
 * a `RawContentStoreRegistry`, not via a single active store. A row
 * created when the deployment was on `local_fs` and still pending
 * cleanup after the deployment switched to `filecoin` is handled by
 * the registered legacy adapter (`RAW_STORAGE_LEGACY_PROVIDERS`).
 * Providers that aren't registered surface as failures with an
 * explicit error message — never silent no-ops.
 *
 * Result shape: `successes` carries one entry per non-failure outcome
 * (including `deleted: false` already-missing) so callers can write the
 * correct terminal marker (`blob_deleted` vs `blob_tombstoned`) based
 * on the adapter's `semantics` field. The legacy `deleted` /
 * `alreadyMissing` counters are kept for backwards-compatible metrics.
 *
 * Failure model: per-blob delete is attempted independently. The
 * adapter's `delete()` already treats "missing" as a NON-ERROR
 * outcome with `deleted: false`. Adapter errors (network, auth,
 * permission, missing provider) are NEVER swallowed — they're
 * collected on `failures` and the caller MUST surface a 500 to the
 * client (see `ManagedBlobCleanupError`). No degraded mode.
 *
 * Hint plumbing: `ManagedBlobRef.rawStorageMetadata` carries the
 * row's `raw_documents.raw_storage_metadata` JSONB so the cleanup
 * loop can hand it to `RawContentStore.delete(uri, hints)` as an
 * opaque `RawContentHints` object. The Filecoin adapter narrows
 * this to `filecoin.data_set_id` + `filecoin.copies[].piece_id`
 * and issues a hinted `deletePiece({ piece: BigInt(pieceId) })`
 * against the resolved context — which bypasses the SDK's
 * CID→active-piece lookup and lets a freshly-uploaded piece
 * (still pre-PDP-proof) be deleted directly. Non-Filecoin
 * adapters (local_fs, s3) ignore the `hints` argument.
 */

import { emitFilecoinEvent } from '../services/filecoin-observability.js';
import type {
  RawContentDeleteResult,
  RawContentHints,
} from './raw-content-store.js';
import type { RawContentStoreRegistry } from './store-registry.js';

export interface ManagedBlobRef {
  /** Source-row id — required so the cleanup loop can sync the
   * paired `storage_artifacts` row by id (URIs are not globally
   * unique across documents). */
  rawDocumentId: string;
  storageProvider: string;
  storageUri: string;
  /** `raw_documents.raw_storage_metadata` JSONB (defaulted to `{}`
   * by the repository mapper for legacy rows). Threaded through
   * to `RawContentStore.delete` as opaque `RawContentHints` —
   * each adapter narrows its own provider sibling. Required:
   * production repository rows always populate it (the
   * `toManagedBlobRef` mapper coerces missing/non-object JSONB
   * to `{}`), and direct test callers pass `{}` explicitly. */
  rawStorageMetadata: Record<string, unknown>;
}

/**
 * Result entries DO NOT extend `ManagedBlobRef`. `rawStorageMetadata`
 * is INPUT-ONLY hint material (Filecoin sidecar fields like
 * `data_set_id` / `copies[].piece_id`) and must never appear on
 * a result record or in `ManagedBlobCleanupError.result` — those
 * surface to route handlers / 500 envelopes / observability and
 * the hint sidecar isn't on the public allowlist. The cleanup
 * loop hands the metadata to `RawContentStore.delete` and then
 * drops it before constructing the entry below.
 */
export interface ManagedBlobCleanupSuccess {
  rawDocumentId: string;
  storageProvider: string;
  storageUri: string;
  /** True when the adapter actively removed bytes; false for already-missing. */
  deleted: boolean;
  /** What the adapter's delete did — drives terminal marker selection. */
  semantics: RawContentDeleteResult['semantics'];
}

export interface ManagedBlobFailure {
  rawDocumentId: string;
  storageProvider: string;
  storageUri: string;
  message: string;
}

export interface ManagedBlobCleanupResult {
  attempted: number;
  /** Count metric — number of `successes` with `deleted=true`. */
  deleted: number;
  /** Count metric — number of `successes` with `deleted=false`. */
  alreadyMissing: number;
  /** One entry per non-failure outcome; iteration drives marker writes. */
  successes: ManagedBlobCleanupSuccess[];
  failures: ManagedBlobFailure[];
}

export async function cleanupManagedBlobs(
  registry: RawContentStoreRegistry,
  blobs: ManagedBlobRef[],
): Promise<ManagedBlobCleanupResult> {
  const result: ManagedBlobCleanupResult = {
    attempted: blobs.length,
    deleted: 0,
    alreadyMissing: 0,
    successes: [],
    failures: [],
  };
  for (const blob of blobs) {
    await processOneBlob(registry, blob, result);
  }
  return result;
}

/**
 * Process a single blob through the registry-resolved adapter
 * and append the outcome to `result`. Split out so the outer
 * loop stays under the workspace complexity caps after the
 * Phase 7 observability emit was added.
 *
 * Closed-key discipline: we NEVER spread `...blob` into a
 * result entry — that would carry `rawStorageMetadata` (the
 * Filecoin sidecar with `piece_id` / `data_set_id` / planted
 * secrets) into the success/failure output, the
 * `ManagedBlobCleanupError.result` payload, and downstream
 * observability. Each entry is built from the three public
 * fields (`rawDocumentId`, `storageProvider`, `storageUri`)
 * plus the adapter's own scalars (`deleted`, `semantics`,
 * `message`). The `RawContentDeleteResult.txHash` field, when
 * present, is routed ONLY to the internal observability event
 * — never to the success entry. Pinned by
 * `cleanup-leak-invariants.test.ts`.
 */
async function processOneBlob(
  registry: RawContentStoreRegistry,
  blob: ManagedBlobRef,
  result: ManagedBlobCleanupResult,
): Promise<void> {
  const publicRef = {
    rawDocumentId: blob.rawDocumentId,
    storageProvider: blob.storageProvider,
    storageUri: blob.storageUri,
  };
  const store = registry.get(blob.storageProvider);
  if (!store) {
    result.failures.push({
      ...publicRef,
      message:
        `managed_blob cleanup requested for provider '${blob.storageProvider}' but no ` +
        'adapter is registered. Set RAW_STORAGE_LEGACY_PROVIDERS to include this provider, ' +
        'or migrate the row before retiring its adapter.',
    });
    return;
  }
  try {
    const r = await store.delete(blob.storageUri, blob.rawStorageMetadata as RawContentHints);
    if (r.deleted) result.deleted++;
    else result.alreadyMissing++;
    emitDeleteTxHashIfAny(blob.storageProvider, r);
    result.successes.push({ ...publicRef, deleted: r.deleted, semantics: r.semantics });
  } catch (err) {
    result.failures.push({
      ...publicRef,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Phase 7 billing/cost-impact metadata. If the Filecoin adapter
 * returned an on-chain `txHash` (the Synapse SDK's `deletePiece`
 * scheduled-removal tx), emit it on the internal
 * `filecoin.delete.tombstoned` observability event for
 * operator-side cost auditing. The hash NEVER reaches the
 * cleanup-result DTO — it travels only on the closed
 * `FilecoinEventPayload.deleteTxHash` channel.
 */
function emitDeleteTxHashIfAny(
  storageProvider: string,
  r: RawContentDeleteResult,
): void {
  if (r.txHash === undefined || storageProvider !== 'filecoin') return;
  emitFilecoinEvent('filecoin.delete.tombstoned', {
    provider: storageProvider,
    deleteTxHash: r.txHash,
    statusAfter: r.semantics === 'deleted' ? 'blob_deleted' : 'blob_tombstoned',
  });
}

/**
 * Thrown by callers when one or more blob deletes raised. Wraps the
 * cleanup result so the route layer can surface a 500 with the failed
 * URIs instead of silently corrupting the cleanup contract.
 */
export class ManagedBlobCleanupError extends Error {
  constructor(public readonly result: ManagedBlobCleanupResult) {
    const first = result.failures[0];
    super(
      `managed_blob cleanup failed: ${result.failures.length} of ${result.attempted} ` +
        `(first: ${first?.storageUri ?? '<unknown>'}: ${first?.message ?? '<no message>'})`,
    );
    this.name = 'ManagedBlobCleanupError';
  }
}
