/**
 * @file Wire-envelope mapping for `StorageService` typed errors.
 *
 * Extracted from `routes/storage.ts` so the route module stays
 * focused on route registration and request handling. The mapping
 * is a data-driven `STORAGE_ERROR_DISPATCH` table — one row per
 * typed error — plus a focused `sendXxx` helper per error so the
 * response shape for each is reviewable in isolation.
 *
 * Public entry point: `handleStorageError(res, err)` returns true
 * when it sent a response and the caller should stop. The
 * `LegacyUserIdRejection` class is re-exported because the route
 * module throws it from `readUserId` (storage routes reject the
 * legacy `?user_id=` / body shape; the auth header is the only
 * accepted source).
 */

import type { Response } from 'express';
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
} from '../services/storage-service-errors.js';

/**
 * Thrown by `readUserId` when a storage route request carries the
 * legacy `?user_id=` query or body `user_id` shape instead of the
 * `X-AtomicMemory-User-Id` header. Kept here (not in
 * `storage-service-errors.ts`) because it is a route-layer concept
 * — the service doesn't know how identity arrived on the wire.
 */
export class LegacyUserIdRejection extends Error {
  constructor() {
    super(
      'legacy ?user_id= query or body user_id is no longer accepted; ' +
        'send X-AtomicMemory-User-Id header instead',
    );
    this.name = 'LegacyUserIdRejection';
  }
}

type StorageErrorHandler = (res: Response, err: unknown) => boolean;

const STORAGE_ERROR_DISPATCH: ReadonlyArray<readonly [Function, StorageErrorHandler]> = [
  [StorageArtifactNotFoundError, (r, e) => send404NotFound(r, e as StorageArtifactNotFoundError)],
  [PointerContentNotManagedError, (r, e) => send409PointerContent(r, e as PointerContentNotManagedError)],
  [FilecoinDirectStorageNotSupportedError, (r, e) => send501Filecoin(r, e as FilecoinDirectStorageNotSupportedError)],
  [UnsupportedPointerSchemeError, (r, e) => send400UnsupportedScheme(r, e as UnsupportedPointerSchemeError)],
  [ArtifactInUseError, (r, e) => send409InUse(r, e as ArtifactInUseError)],
  [ArtifactDeleteInFlightError, (r, e) => send409DeleteInFlight(r, e as ArtifactDeleteInFlightError)],
  [ManagedStorageDisabledError, (r, e) => send503ManagedDisabled(r, e as ManagedStorageDisabledError)],
  [BackendNotRegisteredError, (r, e) => send503BackendUnavailable(r, e as BackendNotRegisteredError)],
  [UnregisteredProviderError, (r, e) => send503UnregisteredProvider(r, e as UnregisteredProviderError)],
  [PutPostPersistError, (r, e) => send503PutPostPersist(r, e as PutPostPersistError)],
  [ArtifactNotReadyError, (r, e) => send409ArtifactNotReady(r, e as ArtifactNotReadyError)],
  [ArtifactUnavailableError, (r, e) => send410ArtifactUnavailable(r, e as ArtifactUnavailableError)],
  [InvalidArtifactMetadataError, (r, e) => send400Metadata(r, e as InvalidArtifactMetadataError)],
  [LegacyUserIdRejection, (r, e) => send400LegacyUserId(r, e as LegacyUserIdRejection)],
];

/**
 * Map a service-layer typed error to its HTTP envelope. Returns
 * `true` when the response was sent and the caller should stop.
 * Returns `false` when no row matched — the caller (route layer)
 * should fall through to its generic 500 handler.
 */
export function handleStorageError(res: Response, err: unknown): boolean {
  for (const [ctor, handler] of STORAGE_ERROR_DISPATCH) {
    if (err instanceof (ctor as new (...args: never[]) => Error)) return handler(res, err);
  }
  return false;
}

function send404NotFound(res: Response, err: StorageArtifactNotFoundError): boolean {
  res.status(404).json({ error_code: 'artifact_not_found', error: err.message });
  return true;
}

function send409PointerContent(res: Response, err: PointerContentNotManagedError): boolean {
  res.status(409).json({
    error_code: 'pointer_content_not_managed',
    error: err.message,
    uri: err.uri,
    hint: 'Fetch the URI directly; the server does not proxy pointer content.',
  });
  return true;
}

function send501Filecoin(res: Response, err: FilecoinDirectStorageNotSupportedError): boolean {
  res.status(501).json({
    error_code: err.provider === 'filecoin'
      ? 'filecoin_direct_storage_not_yet_supported'
      : 'provider_direct_storage_not_yet_supported',
    error: err.message,
    follow_up: 'Use document ingestion or pointer mode.',
  });
  return true;
}

function send400UnsupportedScheme(res: Response, err: UnsupportedPointerSchemeError): boolean {
  res.status(400).json({
    error_code: 'invalid_pointer_uri_scheme',
    error: err.message,
    allowed_schemes: err.allowedSchemes,
  });
  return true;
}

function send409InUse(res: Response, err: ArtifactInUseError): boolean {
  res.status(409).json({
    error_code: 'artifact_in_use',
    error: err.message,
    referenced_by_document_count: err.referencedByDocumentCount,
    follow_up: "Pass `?policy=with_documents` to cascade.",
  });
  return true;
}

function send409DeleteInFlight(res: Response, err: ArtifactDeleteInFlightError): boolean {
  res.status(409).json({
    error_code: 'delete_in_flight',
    error: err.message,
    artifact_id: err.artifactId,
    current_status: err.currentStatus,
    retryable: true,
  });
  return true;
}

function send503ManagedDisabled(res: Response, err: ManagedStorageDisabledError): boolean {
  res.status(503).json({ error_code: 'managed_storage_disabled', error: err.message });
  return true;
}

function send503BackendUnavailable(res: Response, err: BackendNotRegisteredError): boolean {
  // Sanitized envelope: provider_id is the only identifier the
  // client can use to ask the operator to re-register the adapter.
  // Internal stack/error text stays server-side.
  res.status(503).json({
    error_code: 'storage_backend_unavailable',
    error: `the storage backend for provider '${err.providerId}' is not registered with this deployment`,
    provider_id: err.providerId,
  });
  return true;
}

function send503UnregisteredProvider(res: Response, err: UnregisteredProviderError): boolean {
  // Composition-level variant of `storage_backend_unavailable`:
  // fires at putManaged entry when the active backend's provider
  // isn't registered with the deployment's registry. Same wire
  // envelope as `BackendNotRegisteredError` so clients have one
  // contract.
  res.status(503).json({
    error_code: 'storage_backend_unavailable',
    error: `provider '${err.providerId}' is not registered with this deployment`,
    provider_id: err.providerId,
  });
  return true;
}

function send503PutPostPersist(res: Response, err: PutPostPersistError): boolean {
  // Sanitized envelope: artifact_id + provider_id are public; the
  // orphan URI lives on the server side (event log + the row's
  // internal `last_error`) and is NEVER on the wire.
  res.status(503).json({
    error_code: 'put_post_persist_failed',
    error: 'the storage backend accepted the bytes but the server could not finalize the artifact',
    artifact_id: err.artifactId,
    provider_id: err.providerId,
  });
  return true;
}

function send409ArtifactNotReady(res: Response, err: ArtifactNotReadyError): boolean {
  res.status(409).json({
    error_code: 'artifact_not_ready',
    error: err.message,
    artifact_id: err.artifactId,
    hint: 'The managed upload is still pending finalization; retry after a short delay.',
  });
  return true;
}

function send410ArtifactUnavailable(res: Response, err: ArtifactUnavailableError): boolean {
  res.status(410).json({
    error_code: 'artifact_unavailable',
    error: err.message,
    artifact_id: err.artifactId,
    reason: err.reason,
  });
  return true;
}

function send400Metadata(res: Response, err: InvalidArtifactMetadataError): boolean {
  const isHeader = err.reason.toLowerCase().includes('header');
  res.status(400).json({
    error_code: isHeader ? 'invalid_metadata_header' : 'invalid_metadata',
    error: err.message,
    hint: err.reason,
  });
  return true;
}

function send400LegacyUserId(res: Response, err: LegacyUserIdRejection): boolean {
  res.status(400).json({
    error_code: 'legacy_user_id_unsupported',
    error: err.message,
    hint: 'Pass identity in the X-AtomicMemory-User-Id header instead.',
  });
  return true;
}
