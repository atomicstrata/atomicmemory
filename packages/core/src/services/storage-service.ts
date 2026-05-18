/**
 * @file Direct storage API orchestration — the seam between the
 * route layer and the `storage_artifacts` repository + the managed
 * `StorageBackend`.
 *
 * Owns the put-pointer/managed branch, get-content pointer-mode 409,
 * the delete-policy state
 * machine (claim → backend-call → mark-success/failure), and the
 * verify shim. Pointer URIs are validated against the operator
 * allowlist here; the service NEVER fetches a pointer URI.
 *
 * Filecoin-shaped direct managed uploads are gated with a 501 by throwing
 * `FilecoinDirectStorageNotSupportedError` before the backend is
 * touched. Pointer mode against these providers is still allowed (it is
 * metadata-only and backend-independent).
 */

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  claimDeleteAttempt,
  claimPendingArtifact,
  countReferencingDocuments,
  createStorageArtifact,
  getStorageArtifactById,
  getStorageArtifactByIdIncludingDeleted,
  listArtifactsForUser,
  listReferencingDocumentIds,
  releaseDeleteClaim,
  type StorageArtifactRow,
  type ListArtifactsOptions,
  type ListArtifactsResult,
} from '../db/storage-artifact-repository.js';
import {
  errorMessage,
  persistUploadedOrRecover,
  recordBackendPutFailure,
} from './storage-put-recovery.js';
import { deriveStorageKeyPrefix } from './storage-key-prefix.js';
import {
  finalizeArtifactDeleteFailureTx,
  finalizeArtifactDeleteSuccessTx,
} from '../db/storage-artifact-delete-tx.js';
import { softDeleteDocumentCascade } from '../db/repository-document-delete.js';
import type { PointerUriScheme } from '../config.js';
import {
  isAllowlistedPointerUri,
} from '../storage/pointer-uri-allowlist.js';
import { EXTERNAL_POINTER_PROVIDER } from '../db/storage-artifact-providers.js';
import type { StorageBackend } from '../storage/storage-backend.js';
import type { StorageBackendRegistry } from '../storage/storage-backend-registry.js';
import {
  ArtifactDeleteInFlightError,
  ArtifactInUseError,
  ArtifactNotReadyError,
  ArtifactUnavailableError,
  BackendNotRegisteredError,
  FilecoinDirectStorageNotSupportedError,
  InvalidArtifactMetadataError,
  ManagedStorageDisabledError,
  PointerContentNotManagedError,
  PutPostPersistError,
  StorageArtifactNotFoundError,
  UnregisteredProviderError,
  UnsupportedPointerSchemeError,
} from './storage-service-errors.js';

const FILECOIN_PROVIDER = 'filecoin';
const POINTER_ONLY_PROVIDER = 'none';
/**
 * Providers that reject `POST /v1/storage/artifacts?mode=managed`
 * with a typed 501 BEFORE `claimPendingArtifact` runs, so no
 * `storage_artifacts` row is created for the rejected request.
 * Only `filecoin` is currently carved out. Other eventual-consistency
 * providers can join this set if their readiness model also requires
 * document-scoped upload paths.
 */
const DIRECT_MANAGED_UNSUPPORTED_PROVIDERS = new Set([FILECOIN_PROVIDER]);

export type ArtifactMetadata = Record<string, string | number | boolean>;

export interface PutPointerInput {
  userId: string;
  uri: string;
  contentType: string;
  sizeBytes?: number | null;
  contentHash?: string | null;
  metadata?: ArtifactMetadata;
}

export interface PutManagedInput {
  userId: string;
  body: Buffer;
  contentType: string;
  discloseContentHash: boolean;
  metadata?: ArtifactMetadata;
}

export type DeleteArtifactPolicy = 'artifact_only' | 'with_documents';

export interface DeleteArtifactInput {
  userId: string;
  id: string;
  policy: DeleteArtifactPolicy;
}

export interface DeleteArtifactResult {
  artifact: StorageArtifactRow;
  cascadedDocumentIds: string[];
}

export type VerifyArtifactResult =
  | { kind: 'verified'; details?: Record<string, unknown> }
  | { kind: 'failed'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface StorageServiceDeps {
  pool: pg.Pool;
  /**
   * Per-row backend dispatch registry. The service's read/delete/verify
   * paths look up the backend matching the row's `provider` column;
   * the write path (`putManaged`) writes through `registry.active`.
   * Pointer artifacts never reach the registry — they short-circuit
   * in `getArtifactContent`, `deleteArtifact` (`executeBackendDelete`),
   * and `verifyArtifact` before any lookup. Pointer-only deployments
   * pass a registry with `active === null` and no legacy backends.
   *
   * Legacy callers that pass a single `backend` can wrap it with
   * `singleBackendRegistry(backend)`.
   */
  backendRegistry: StorageBackendRegistry;
  /** Allowlisted pointer-mode URI schemes captured at startup. */
  pointerSchemes: ReadonlyArray<PointerUriScheme>;
  /**
   * `RuntimeConfig.storageKeyHmacSecret` — used by `putManaged` to
   * derive a PII-safe per-user prefix for the backend key. Replaces
   * the plaintext `users/${userId}/...` leg of the previous key
   * shape. Required at startup; never read env here. See
   * `storage-key-prefix.ts` for the derivation contract.
   */
  storageKeyHmacSecret: string;
}

export class StorageService {
  private readonly pool: pg.Pool;
  private readonly backendRegistry: StorageBackendRegistry;
  private readonly pointerSchemes: ReadonlyArray<PointerUriScheme>;
  private readonly storageKeyHmacSecret: string;

  constructor(deps: StorageServiceDeps) {
    this.pool = deps.pool;
    this.backendRegistry = deps.backendRegistry;
    this.pointerSchemes = deps.pointerSchemes;
    this.storageKeyHmacSecret = deps.storageKeyHmacSecret;
  }

  /** The backend the deployment writes NEW managed artifacts to. */
  private get activeBackend(): StorageBackend | null {
    return this.backendRegistry.active;
  }

  /**
   * Resolve the backend for an already-persisted managed-mode row.
   * Throws `BackendNotRegisteredError` when no adapter matches the
   * row's `provider`. Pointer rows must short-circuit before this is
   * called; calling it on a pointer row is a service-layer bug.
   */
  private resolveBackendForRow(row: StorageArtifactRow): StorageBackend {
    if (row.mode !== 'managed') {
      throw new Error(
        `resolveBackendForRow: row '${row.id}' is mode='${row.mode}'; ` +
          'pointer-mode dispatch must short-circuit before backend lookup',
      );
    }
    const backend = this.backendRegistry.get(row.provider);
    if (backend === undefined) throw new BackendNotRegisteredError(row.provider, row.id);
    return backend;
  }

  async putPointer(input: PutPointerInput): Promise<StorageArtifactRow> {
    if (!isAllowlistedPointerUri(input.uri, this.pointerSchemes)) {
      throw new UnsupportedPointerSchemeError(input.uri, this.pointerSchemes);
    }
    const provider = this.activeBackend?.provider ?? POINTER_ONLY_PROVIDER;
    return createStorageArtifact(this.pool, {
      userId: input.userId,
      provider,
      mode: 'pointer',
      uri: input.uri,
      status: 'stored',
      sizeBytes: input.sizeBytes ?? null,
      contentType: input.contentType,
      contentEncoding: 'identity',
      discloseContentHash: false,
      identifiers: input.contentHash ? { contentHash: input.contentHash } : {},
      metadata: input.metadata ?? {},
    });
  }

  /**
   * Managed-mode put — pending-row-first contract.
   *
   * 1. Validate gates: managed-storage enabled, provider registered,
   *    Filecoin-direct carve-out (501).
   * 2. INSERT a `status='pending'` row with `uri=NULL` and a fresh
   *    `put_attempt_id`. (This is the DB claim; no backend call yet.)
   * 3. Call `backend.put(...)` OUTSIDE the DB transaction.
   * 4. On `backend.put` success: CAS-flip the row to `'stored'` via
   *    `recordUploadedArtifact`. Recovery handles the rare case
   *    where that UPDATE fails after the bytes are at the backend
   *    (single immediate retry, then backend cleanup, then a
   *    best-effort failure marker — see `recoverPostPutFailure`).
   * 5. On `backend.put` failure: CAS-flip the row to `'failed'` via
   *    `markPutFailed`, then re-throw the original backend error.
   */
  async putManaged(input: PutManagedInput): Promise<StorageArtifactRow> {
    const backend = this.requireWritableBackend();
    const claim = await claimPendingArtifact(this.pool, {
      userId: input.userId,
      provider: backend.provider,
      contentType: input.contentType,
      discloseContentHash: input.discloseContentHash,
      metadata: input.metadata,
    });
    const userPrefix = deriveStorageKeyPrefix(this.storageKeyHmacSecret, input.userId);
    const key = `s/${userPrefix}/${claim.row.id}.bin`;
    let putResult;
    try {
      putResult = await backend.put({ key, body: input.body, contentType: input.contentType });
    } catch (putError) {
      await recordBackendPutFailure({
        pool: this.pool,
        userId: input.userId,
        claim,
        provider: backend.provider,
        putError,
      });
      throw putError;
    }
    return persistUploadedOrRecover({
      pool: this.pool,
      userId: input.userId,
      backend,
      claim,
      putResult,
    });
  }

  /**
   * Validate the deployment can accept a managed write. Throws
   * `ManagedStorageDisabledError` for pointer-only deployments,
   * `FilecoinDirectStorageNotSupportedError` for the v1
   * content-addressed eventual-provider carve-out, and
   * `UnregisteredProviderError` as a defensive check
   * against a composition bug where `active` isn't in the registry.
   */
  private requireWritableBackend(): StorageBackend {
    const backend = this.activeBackend;
    if (backend === null) throw new ManagedStorageDisabledError();
    if (DIRECT_MANAGED_UNSUPPORTED_PROVIDERS.has(backend.provider)) {
      throw new FilecoinDirectStorageNotSupportedError(backend.provider);
    }
    if (!this.backendRegistry.has(backend.provider)
        && backend.provider !== EXTERNAL_POINTER_PROVIDER) {
      throw new UnregisteredProviderError(backend.provider);
    }
    return backend;
  }


  async getArtifactMetadata(userId: string, id: string): Promise<StorageArtifactRow> {
    const row = await getStorageArtifactById(this.pool, userId, id);
    if (row === null) throw new StorageArtifactNotFoundError(id);
    return row;
  }

  async getArtifactContent(
    userId: string,
    id: string,
  ): Promise<{ row: StorageArtifactRow; body: Buffer }> {
    const row = await this.getArtifactMetadata(userId, id);
    // Pointer short-circuit — never consults the backend registry.
    // Pointer rows always have `uri` set at insert time; assert.
    if (row.mode === 'pointer') {
      throw new PointerContentNotManagedError(row.id, requireUri(row));
    }
    // Managed lifecycle gates before backend dispatch: pending and
    // failed rows have `uri=null` (the upload never reached the
    // `stored` CAS), so a public read against them must surface a
    // typed envelope instead of falling through to `requireUri`'s
    // service-layer bug.
    if (row.status === 'pending') {
      throw new ArtifactNotReadyError(row.id);
    }
    if (row.uri === null || row.status === 'failed') {
      throw new ArtifactUnavailableError(row.id, 'artifact bytes were never persisted');
    }
    // Managed dispatch: resolve the backend whose provider matches
    // the row, not the active write backend. A row written under
    // `local_fs` keeps working after the deployment switches to
    // `s3` as long as `local_fs` stays registered (legacy).
    const backend = this.resolveBackendForRow(row);
    const fetched = await backend.get(row.uri);
    return { row, body: fetched.body };
  }

  async listArtifacts(
    userId: string,
    opts: ListArtifactsOptions,
  ): Promise<ListArtifactsResult> {
    return listArtifactsForUser(this.pool, userId, opts);
  }

  async deleteArtifact(input: DeleteArtifactInput): Promise<DeleteArtifactResult> {
    // The delete path is allowed to see soft-deleted rows so a
    // second `DELETE` on a `deleted` artifact returns the prior
    // terminal envelope (plan's idempotency contract).
    const initial = await getStorageArtifactByIdIncludingDeleted(
      this.pool,
      input.userId,
      input.id,
    );
    if (initial === null) throw new StorageArtifactNotFoundError(input.id);
    if (initial.status === 'deleted') {
      return { artifact: initial, cascadedDocumentIds: [] };
    }
    // Pre-resolve the backend for managed rows BEFORE any DB
    // mutation (Commit B fix). Pending/failed rows with `uri=null`
    // and pointer rows skip resolution — they have no bytes to
    // clean up at any backend.
    const resolvedBackend = initial.mode === 'managed' && initial.uri !== null
      ? this.resolveBackendForRow(initial)
      : null;
    // Claim BEFORE checking references (Commit D fix). Once the
    // row is in `status='deleting'`, `assertArtifactLinkable`
    // refuses to attach new `raw_documents.storage_artifact_id`
    // references, so the reference count is stable for the rest
    // of this call. `delete_failed` retries re-claim and re-check
    // refs, so a new link added between retries surfaces as
    // `ArtifactInUseError` instead of being silently bulldozed.
    const claim = await claimDeleteAttempt(this.pool, input.userId, input.id);
    if (claim === null) {
      // Claim refused — disambiguate by re-reading the row. Three
      // outcomes:
      //   - row gone / cross-user → 404 (matches initial gate)
      //   - row terminal `deleted` → idempotent success envelope
      //     (the plan's idempotency contract for a second DELETE
      //     on an already-deleted artifact)
      //   - anything else (chiefly `deleting`, also a transient
      //     `delete_failed` from a sibling's just-finalized failure)
      //     → 409 `delete_in_flight`. Returning the row as if THIS
      //     caller succeeded was the prior bug — the caller never
      //     ran cascade or backend.delete, so claiming success
      //     would falsely promise a delete this caller didn't
      //     perform.
      const reread = await getStorageArtifactByIdIncludingDeleted(
        this.pool,
        input.userId,
        input.id,
      );
      if (reread === null) throw new StorageArtifactNotFoundError(input.id);
      if (reread.status === 'deleted') {
        return { artifact: reread, cascadedDocumentIds: [] };
      }
      throw new ArtifactDeleteInFlightError(input.id, reread.status);
    }
    let cascadedDocumentIds: string[];
    try {
      cascadedDocumentIds = await this.maybeCascadeDocuments(input);
    } catch (err) {
      // Release the claim so the artifact returns to its
      // pre-delete state. Without this revert the row would stay
      // at `status='deleting'` forever (or until another delete
      // call). Restore the pre-claim `last_error` too —
      // `claimDeleteAttempt` clears it on entry so a successful
      // delete doesn't surface stale errors, but a refused delete
      // shouldn't blank an existing operator-visible failure.
      await releaseDeleteClaim(this.pool, {
        userId: input.userId,
        id: input.id,
        claimId: claim.claimId,
        restoreStatus: initial.status,
        restoreLastError: initial.lastError,
      });
      throw err;
    }
    const finalized = await this.executeBackendDelete(
      input, initial, resolvedBackend, claim.claimId, cascadedDocumentIds,
    );
    return { artifact: finalized, cascadedDocumentIds };
  }

  async verifyArtifact(userId: string, id: string): Promise<VerifyArtifactResult> {
    const row = await this.getArtifactMetadata(userId, id);
    // Pointer short-circuit — never consults the backend registry.
    if (row.mode === 'pointer') {
      return { kind: 'unsupported', reason: 'pointer-mode artifacts are not server-verifiable' };
    }
    // Lifecycle gates: pending/failed rows have no bytes to verify.
    // The `verify` envelope is the natural surface for this — we
    // return `kind: 'unsupported'` / `'failed'` rather than throwing,
    // matching the existing pointer-row pattern.
    if (row.status === 'pending') {
      return { kind: 'unsupported', reason: 'artifact is still pending upload finalization' };
    }
    if (row.uri === null || row.status === 'failed') {
      return { kind: 'failed', reason: 'artifact bytes were never persisted' };
    }
    // Per-row dispatch: every managed provider (including filecoin)
    // resolves through the registry. Filecoin's `head` is a real
    // adapter call when registered; an unregistered provider raises
    // `BackendNotRegisteredError`, mapped by the route to 503
    // `storage_backend_unavailable`.
    const backend = this.resolveBackendForRow(row);
    const head = await backend.head(row.uri);
    if (head.exists) {
      return { kind: 'verified', details: { sizeBytes: head.sizeBytes ?? row.sizeBytes ?? 0 } };
    }
    return { kind: 'failed', reason: 'backend reports the artifact bytes are not present' };
  }

  /**
   * Reference-count gate + optional document cascade. Runs INSIDE
   * the claim window (Commit D): the artifact is already in
   * `status='deleting'`, so concurrent INSERTs are refused by
   * `assertArtifactLinkable` at the link-write sites — the count
   * is stable for the rest of the call.
   *
   * Every `delete_failed` retry rechecks references too. The old
   * "delete_failed short-circuits the gate" rule could silently
   * bulldoze a fresh link added between attempts; this implementation
   * refuses to finalize unless the policy explicitly opts into a
   * cascade.
   *
   * On `ArtifactInUseError` the caller releases the claim and the
   * row goes back to its pre-delete state.
   */
  private async maybeCascadeDocuments(
    input: DeleteArtifactInput,
  ): Promise<string[]> {
    const count = await countReferencingDocuments(this.pool, input.userId, input.id);
    if (count === 0) return [];
    if (input.policy !== 'with_documents') {
      throw new ArtifactInUseError(input.id, count);
    }
    return this.cascadeDocuments(input.userId, input.id);
  }

  private async cascadeDocuments(userId: string, artifactId: string): Promise<string[]> {
    const ids = await listReferencingDocumentIds(this.pool, userId, artifactId);
    const removed: string[] = [];
    for (const documentId of ids) {
      const result = await softDeleteDocumentCascade(this.pool, userId, documentId);
      if (result.removed) removed.push(documentId);
    }
    return removed;
  }

  /**
   * Run the backend cleanup ONCE (skipped when `backend === null`,
   * which is the pointer-mode case — pointer rows have no bytes at
   * a backend), then finalize the artifact AND propagate the
   * terminal state to every cascaded document in one atomic paired
   * transaction (`finalizeArtifactDeleteSuccessTx` / `…FailureTx`).
   *
   * `backend.delete` runs OUTSIDE the transaction (it is a network
   * call); the DB finalization either commits both rows together or
   * rolls them both back. A partial commit that leaves the artifact
   * terminal while the linked raw_documents stay at
   * `blob_stored`/`blob_available` is no longer possible. The
   * document cleanup path never sees the URI here, so there is no
   * double-delete of the backend object.
   *
   * The backend is resolved BEFORE this is called (see
   * `deleteArtifact` above), so this function never needs to handle
   * `BackendNotRegisteredError`. Any thrown backend error here is a
   * runtime delete failure (network outage, etc.) and lands the
   * artifact in `delete_failed` with a sanitized envelope.
   */
  private async executeBackendDelete(
    input: DeleteArtifactInput,
    initial: StorageArtifactRow,
    backend: StorageBackend | null,
    claimId: string,
    cascadedDocumentIds: ReadonlyArray<string>,
  ): Promise<StorageArtifactRow> {
    let semantics: 'deleted' | 'unpinned' | 'tombstoned' = 'deleted';
    try {
      // Managed rows with a URI go through the backend cleanup.
      // Pending rows with `uri=null` (upload claim, no bytes yet)
      // and failed rows with `uri=null` (backend.put threw) have
      // no backend object to delete — the DB CAS is the entire
      // delete. Pointer rows skip backend.delete unconditionally
      // (they have no bytes either).
      if (initial.mode === 'managed' && backend !== null && initial.uri !== null) {
        const result = await backend.delete(initial.uri);
        semantics = result.semantics ?? 'deleted';
      }
    } catch (err) {
      return finalizeArtifactDeleteFailureTx(this.pool, {
        userId: input.userId,
        artifactId: input.id,
        claimId,
        cascadedDocumentIds,
        lastError: { layer: 'raw_storage', code: 'backend_delete_failed', message: errorMessage(err) },
      });
    }
    return finalizeArtifactDeleteSuccessTx(this.pool, {
      userId: input.userId,
      artifactId: input.id,
      claimId,
      cascadedDocumentIds,
      semantics,
    });
  }
}

/**
 * Validate caller-supplied metadata: closed value type
 * (`string | number | boolean` only) and ≤ 4 KiB serialized JSON.
 * Throws `InvalidArtifactMetadataError` on violation. The route
 * layer reuses this for both the pointer-mode JSON `metadata` field
 * and the managed-mode `X-AtomicMemory-Metadata` header.
 */
const ARTIFACT_METADATA_DECODED_MAX_BYTES = 4 * 1024;

export function validateArtifactMetadata(value: unknown): ArtifactMetadata {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidArtifactMetadataError('metadata must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(record)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new InvalidArtifactMetadataError(
        `metadata.${key} must be a string, number, or boolean`,
      );
    }
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, 'utf8') > ARTIFACT_METADATA_DECODED_MAX_BYTES) {
    throw new InvalidArtifactMetadataError(
      `metadata exceeds the ${ARTIFACT_METADATA_DECODED_MAX_BYTES}-byte serialized cap`,
    );
  }
  return record as ArtifactMetadata;
}

/** SHA-256 helper exposed for tests of the upload-hash contract. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Assert a `storage_artifacts` row carries a non-null `uri`. Used
 * by every backend-dispatch path; pointer rows ALWAYS carry the URI
 * (set at insert time), and managed rows that reached `stored` /
 * `available` carry it post-CAS. Hitting this on a `pending` /
 * `failed` row indicates the caller bypassed the lifecycle gates,
 * which is a service-layer bug.
 */
function requireUri(row: StorageArtifactRow): string {
  if (row.uri === null) {
    throw new Error(
      `storage-service: row '${row.id}' (mode='${row.mode}', status='${row.status}') ` +
        'has no uri; backend dispatch is only valid for stored / pointer rows',
    );
  }
  return row.uri;
}
