/**
 * Stateless helpers extracted out of `document-upload.ts` to keep the
 * orchestration file under the workspace 400-line cap. These are pure
 * functions + small async wrappers — no orchestration state, no
 * codec/store/registry coupling beyond the typed argument bag.
 */

import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  buildLastError,
  markRawStorageFailedByDocumentId,
} from '../db/raw-document-status-repository.js';
import { getRawDocumentById } from '../db/raw-document-repository.js';
import type { RawDocumentRow } from '../db/raw-document-types.js';
import type { StoredRawContent } from '../storage/raw-content-store.js';

export class UploadDocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} not found`);
    this.name = 'UploadDocumentNotFoundError';
  }
}

export class ManagedStorageDisabledError extends Error {
  constructor() {
    super('managed_blob storage is not enabled for this deployment');
    this.name = 'ManagedStorageDisabledError';
  }
}

export class UploadDocumentConflictError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly existingContentHash: string,
    public readonly incomingContentHash: string,
  ) {
    super(
      `document ${documentId} already has a managed blob with content_hash=` +
        `${existingContentHash}; refusing to overwrite with content_hash=${incomingContentHash}`,
    );
    this.name = 'UploadDocumentConflictError';
  }
}

/**
 * Surfaced when Phase β2 or Phase γ's compare-and-set found 0 rows.
 * Means our claim was lost — another worker reclaimed the row or it
 * was concurrently deleted. Not exported because route handlers
 * currently map any such error to a generic 500; promote to `export`
 * when Phase 8.5 observability needs to discriminate it.
 */
export class UploadClaimLostError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly claimId: string,
    public readonly phase: 'beta2' | 'gamma',
  ) {
    super(
      `upload claim ${claimId} for document ${documentId} was lost between ` +
        `phase α and phase ${phase} (concurrent reclaim or row deletion)`,
    );
    this.name = 'UploadClaimLostError';
  }
}

export interface UploadRawInput {
  userId: string;
  documentId: string;
  body: Buffer;
  contentType?: string;
}

export interface UploadRawResult {
  documentId: string;
  storageProvider: string;
  storageUri: string;
  contentHash: string;
  sizeBytes: number;
  rawStorageStatus: 'blob_stored' | 'blob_pending' | 'blob_available';
  storageMode: 'managed_blob';
  /**
   * INTERNAL metadata shape `{ codec, filecoin?, upload_result }`.
   * Route formatters project this through
   * `formatPublicRawStorageMetadata` before emitting to the wire
   * (rev-fix HIGH 3). Internal callers (Phase γ recovery, tests) can
   * read the full shape directly off this field.
   */
  rawStorageMetadata: Record<string, unknown>;
  idempotentSkip: boolean;
}

export async function loadActive(
  client: pg.PoolClient,
  input: UploadRawInput,
): Promise<RawDocumentRow> {
  const document = await getRawDocumentById(client, input.userId, input.documentId);
  if (!document) throw new UploadDocumentNotFoundError(input.documentId);
  return document;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Build the adapter-relative key the blob is stored under. Includes
 * the content hash so byte-identical re-uploads collide on the same
 * key (no orphan from re-uploading the same content).
 *
 * `userPrefix` MUST be the HMAC-SHA256-derived per-user prefix from
 * `deriveStorageKeyPrefix(secret, userId)`. The plaintext `userId`
 * MUST NEVER appear in any provider key/URI — the HMAC prefix is
 * the PII-safe replacement. Stable across retries (same user → same
 * prefix) so the same-bytes re-upload idempotency contract holds.
 */
export function blobKey(
  prefix: string,
  userPrefix: string,
  documentId: string,
  contentHash: string,
): string {
  const head = prefix.length > 0 ? prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  return `${head}s/${userPrefix}/documents/${documentId}/${contentHash}.bin`;
}

/**
 * Echo the row's existing state as the idempotent-skip response.
 * Phase α returns this when `classifyIdempotent === 'returnExisting'`.
 */
export function idempotentResult(
  document: RawDocumentRow,
  contentHash: string,
  sizeBytes: number,
): UploadRawResult {
  const status = document.rawStorageStatus as 'blob_stored' | 'blob_pending' | 'blob_available';
  return {
    documentId: document.id,
    storageProvider: document.storageProvider ?? '',
    storageUri: document.storageUri ?? '',
    contentHash,
    sizeBytes,
    rawStorageStatus: status,
    storageMode: 'managed_blob',
    rawStorageMetadata: document.rawStorageMetadata,
    idempotentSkip: true,
  };
}

export interface BuildUploadResultArgs {
  documentId: string;
  storageProvider: string;
  storageUri: string;
  contentHash: string;
  sizeBytes: number;
  finalStatus: 'blob_stored' | 'blob_pending' | 'blob_available';
  rawStorageMetadata: Record<string, unknown>;
  idempotentSkip: boolean;
}

export function buildUploadResult(args: BuildUploadResultArgs): UploadRawResult {
  return {
    documentId: args.documentId,
    storageProvider: args.storageProvider,
    storageUri: args.storageUri,
    contentHash: args.contentHash,
    sizeBytes: args.sizeBytes,
    rawStorageStatus: args.finalStatus,
    storageMode: 'managed_blob',
    rawStorageMetadata: args.rawStorageMetadata,
    idempotentSkip: args.idempotentSkip,
  };
}

/**
 * Build the `raw_storage_metadata` JSONB Phase β2 writes:
 *   - `codec`: the encoder's sidecar (name + version + AES-GCM internals).
 *   - spread of `stored.providerMetadata`: `{ filecoin: { ... } }` for
 *     Filecoin; `{}` for immediate providers.
 *   - `upload_result.stored_status`: INTERNAL sidecar Phase γ reads
 *     on the finalize-recovery path. Public formatters strip it.
 */
export function buildPhaseBeta2Metadata(
  stored: StoredRawContent & { codecMetadata: Record<string, unknown> },
): Record<string, unknown> {
  return {
    codec: stored.codecMetadata,
    ...stored.providerMetadata,
    upload_result: { stored_status: stored.status },
  };
}

/**
 * Best-effort `raw_storage_failed` marker. Logs (does not swallow)
 * the marker failure so the original upload error is the one the
 * caller sees.
 */
export async function markRawStorageFailureBestEffort(
  q: pg.Pool,
  userId: string,
  documentId: string,
  code: string,
  message: string,
): Promise<void> {
  try {
    await markRawStorageFailedByDocumentId({
      q, userId, documentId,
      lastError: buildLastError('raw_storage', code, message),
    });
  } catch (markerErr) {
    console.error(
      `[upload-raw] failed to record raw_storage_failed marker for document ${documentId}: ` +
        `${describeError(markerErr)} (original code=${code} message=${message})`,
    );
  }
}
