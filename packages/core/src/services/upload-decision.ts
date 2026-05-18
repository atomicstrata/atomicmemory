/**
 * the managed-upload upload-pipeline decision helpers — pure functions extracted
 * out of `document-upload.ts` so the α/β/β2/γ orchestration stays
 * under the 40-LOC-per-function cap and the decision tables are
 * independently testable.
 *
 *   - `classifyIdempotent` decides what an in-flight `uploadRaw`
 *     should do given the document's current row state + the
 *     incoming content hash. Drives the claim step's idempotency short-
 *     circuit and the same-bytes crash recovery branches.
 *   - `deriveFinalRawStorageStatus` maps the adapter's lifecycle hint
 *     (`'stored'` / `'pending'`) + provider name to the terminal
 *     `raw_storage_status` value the finalization step writes. Provider-aware:
 *     Filecoin `'stored'` is `blob_available` (gateway-confirmed
 *     retrievable), immediate providers stay `blob_stored`.
 *
 * No imports of pg / store / codec — these helpers are 100% pure so
 * tests can drive them with plain row literals.
 */

import type { RawDocumentRow } from '../db/raw-document-types.js';

export type UploadIdempotencyDecision =
  | { kind: 'returnExisting' }
  | { kind: 'reclaimAndUpload' }
  | { kind: 'finalize' };

/**
 * Decision-table classifier: given the row's current state + the
 * incoming content hash, decide whether the claim step can short-circuit
 * (returnExisting), needs to re-run β/β2/γ in full (reclaimAndUpload),
 * or can jump straight to the finalization step (finalize — recovery from a crash
 * that happened between the durable URI-write step's URI write and the finalization step's status
 * flip).
 *
 * Returns `null` when the row's content hash does NOT match — caller
 * runs the existing `hasConflictingManagedBlob` check, which raises a
 * 409 if the slot is occupied with different bytes.
 */
export function classifyIdempotent(
  document: RawDocumentRow,
  contentHash: string,
): UploadIdempotencyDecision | null {
  if (document.contentHash !== contentHash) return null;
  switch (document.rawStorageStatus) {
    case 'blob_stored':
    case 'blob_pending':
    case 'blob_available':
      return { kind: 'returnExisting' };
    case 'blob_uploading':
      // the claim step-only OR Phase-β-only row (crash before the durable URI-write step wrote
      // the URI). Bytes may already be on the provider but we don't
      // have the CID — re-run β + β2 + γ. If the provider is
      // content-addressed-idempotent, the second `store.put()` returns
      // the same CID; if not, this creates a rare orphan-billing risk
      // for provider cleanup.
      if (document.storageUri === null) return { kind: 'reclaimAndUpload' };
      // the durable URI-write step succeeded; crash before the finalization step flipped the status.
      // The URI is durable in the row, the bytes are on the provider.
      // Skip β + β2 entirely; run the finalization step alone. No re-encode, no
      // re-upload, no re-billing.
      return { kind: 'finalize' };
    case 'raw_storage_failed':
      return { kind: 'reclaimAndUpload' };
    default:
      return null;
  }
}

/**
 * Provider-aware terminal status mapping. the finalization step writes the return
 * value as the new `raw_storage_status`.
 *
 *   - Adapter `'pending'` → `blob_pending` regardless of provider
 *     (the reconciler completes the flow).
 *   - Adapter `'stored'` + eventual content-addressed provider →
 *     `blob_available` (the provider has confirmed retrievability;
 *     we skip past `blob_stored` directly to terminal-OK).
 *   - Adapter `'stored'` + any other provider → `blob_stored`
 *     (immediate providers — local_fs / s3).
 */
export function deriveFinalRawStorageStatus(args: {
  storedStatus: 'stored' | 'pending';
  storageProvider: string;
}): 'blob_pending' | 'blob_available' | 'blob_stored' {
  if (args.storedStatus === 'pending') return 'blob_pending';
  if (isEventualContentProvider(args.storageProvider)) return 'blob_available';
  return 'blob_stored';
}

function isEventualContentProvider(provider: string): boolean {
  return provider === 'filecoin';
}

/**
 * Read the persisted `upload_result.stored_status` sidecar the durable URI-write step
 * wrote into `raw_storage_metadata`. the finalization step needs this on the
 * finalize-recovery path because the in-memory `stored` from the provider-write step
 * is null when β + β2 are skipped. Returns null when the sidecar is
 * missing or malformed — caller must defend (the finalization step throws an
 * InvariantError in that case).
 */
export function readPersistedStoredStatus(
  metadata: Record<string, unknown>,
): 'stored' | 'pending' | null {
  const uploadResult = metadata['upload_result'];
  if (!uploadResult || typeof uploadResult !== 'object') return null;
  const stored = (uploadResult as Record<string, unknown>)['stored_status'];
  if (stored === 'stored' || stored === 'pending') return stored;
  return null;
}
