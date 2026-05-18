/**
 * @file Typed errors thrown by `StorageService`.
 *
 * The route layer pattern-matches these by `instanceof` to emit the
 * correct HTTP status + error envelope. Service code never embeds
 * status codes itself; the route is the single place where service
 * outcomes map to HTTP.
 */

export class StorageArtifactNotFoundError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string) {
    super(`storage artifact ${artifactId} not found`);
    this.name = 'StorageArtifactNotFoundError';
    this.artifactId = artifactId;
  }
}

export class PointerContentNotManagedError extends Error {
  readonly artifactId: string;
  readonly uri: string;
  constructor(artifactId: string, uri: string) {
    super(`artifact ${artifactId} is pointer-mode; the server does not proxy pointer content`);
    this.name = 'PointerContentNotManagedError';
    this.artifactId = artifactId;
    this.uri = uri;
  }
}

export class FilecoinDirectStorageNotSupportedError extends Error {
  readonly provider: string;
  constructor(provider = 'filecoin') {
    super(
      `Direct ${provider} artifact uploads are not supported in this version. ` +
        'Use document ingestion or pointer mode.',
    );
    this.name = 'FilecoinDirectStorageNotSupportedError';
    this.provider = provider;
  }
}

export class UnsupportedPointerSchemeError extends Error {
  readonly uri: string;
  readonly allowedSchemes: ReadonlyArray<string>;
  constructor(uri: string, allowedSchemes: ReadonlyArray<string>) {
    super(`pointer URI scheme is not allowlisted: ${uri}`);
    this.name = 'UnsupportedPointerSchemeError';
    this.uri = uri;
    this.allowedSchemes = allowedSchemes;
  }
}

export class ArtifactInUseError extends Error {
  readonly artifactId: string;
  readonly referencedByDocumentCount: number;
  constructor(artifactId: string, count: number) {
    super(`artifact ${artifactId} is referenced by ${count} document(s)`);
    this.name = 'ArtifactInUseError';
    this.artifactId = artifactId;
    this.referencedByDocumentCount = count;
  }
}

export class ManagedStorageDisabledError extends Error {
  constructor() {
    super(
      'managed storage is disabled; the active deployment has ' +
        "rawStorageMode='pointer_only' so no direct managed upload is possible",
    );
    this.name = 'ManagedStorageDisabledError';
  }
}

export class InvalidArtifactMetadataError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`invalid artifact metadata: ${reason}`);
    this.name = 'InvalidArtifactMetadataError';
    this.reason = reason;
  }
}

/**
 * Thrown when a managed-mode artifact row's `provider` is not
 * registered with the active `StorageBackendRegistry`. This is an
 * operational unavailability (the deployment dropped a backend that
 * still has live data), NOT a 5xx crash — the route layer maps it
 * to HTTP 503 `storage_backend_unavailable`. The envelope carries
 * only `provider_id`; internal stack/error details stay server-side.
 */
export class BackendNotRegisteredError extends Error {
  readonly providerId: string;
  readonly artifactId: string;
  constructor(providerId: string, artifactId: string) {
    super(
      `storage_backend_unavailable: artifact '${artifactId}' is backed by ` +
        `provider '${providerId}' which is not registered with this deployment`,
    );
    this.name = 'BackendNotRegisteredError';
    this.providerId = providerId;
    this.artifactId = artifactId;
  }
}

/**
 * Thrown by `StorageService.putManaged` when the put would write
 * through a backend whose provider isn't part of the registry's
 * known set (registered backends + the pointer-only marker). The
 * route maps this to HTTP 503 `storage_backend_unavailable`. Unlike
 * `BackendNotRegisteredError` (which fires on read against an
 * already-persisted row), this fires BEFORE any DB write — the
 * upload is rejected at the entry point.
 */
export class UnregisteredProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(
      `storage_backend_unavailable: provider '${providerId}' is not registered ` +
        'with this deployment',
    );
    this.name = 'UnregisteredProviderError';
    this.providerId = providerId;
  }
}

/**
 * Thrown by `StorageService.putManaged` when `backend.put` succeeded
 * but the post-put DB update and the subsequent recovery (DB retry +
 * backend cleanup of the just-uploaded bytes) ALL failed. At that
 * point the bytes survive at the backend AND the DB does not know
 * the URI. The route maps this to HTTP 503 `put_post_persist_failed`
 * with the artifact id and provider so ops can investigate. The
 * orphan URI is captured server-side (in the row's `last_error`
 * envelope + a structured `storage.put.post_put_unrecoverable`
 * event) but NEVER on the wire.
 */
export class PutPostPersistError extends Error {
  readonly artifactId: string;
  readonly providerId: string;
  /** Orphan URI — internal only; the route never surfaces this on the wire. */
  readonly uri: string;
  constructor(artifactId: string, providerId: string, uri: string, cause: string) {
    super(
      `put_post_persist_failed: backend.put succeeded for artifact '${artifactId}' ` +
        `(provider='${providerId}') but every recovery path failed: ${cause}`,
    );
    this.name = 'PutPostPersistError';
    this.artifactId = artifactId;
    this.providerId = providerId;
    this.uri = uri;
  }
}

/**
 * Thrown when a public API caller requests bytes or verifies an
 * artifact whose managed upload is still in flight (`status='pending'`).
 * Route maps this to HTTP 409 `artifact_not_ready`. Distinct from
 * `ArtifactUnavailableError` (terminal `failed`) because the row
 * MIGHT still reach `stored` if the upload finishes.
 */
export class ArtifactNotReadyError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string) {
    super(`artifact ${artifactId} is still pending upload finalization`);
    this.name = 'ArtifactNotReadyError';
    this.artifactId = artifactId;
  }
}

/**
 * Thrown when a public API caller requests bytes or verifies an
 * artifact whose managed upload terminally failed (`status='failed'`
 * with no URI). The row exists for ops visibility — the caller's
 * action against it would never succeed because the backend never
 * persisted the bytes. Route maps this to HTTP 410 `artifact_unavailable`.
 */
export class ArtifactUnavailableError extends Error {
  readonly artifactId: string;
  readonly reason: string;
  constructor(artifactId: string, reason: string) {
    super(`artifact ${artifactId} is unavailable: ${reason}`);
    this.name = 'ArtifactUnavailableError';
    this.artifactId = artifactId;
    this.reason = reason;
  }
}

/**
 * Thrown by `deleteArtifact` when `claimDeleteAttempt` returns null
 * AND the row is currently in `status='deleting'` — another caller
 * holds an active claim and is mid-cascade / mid-backend-delete.
 *
 * Distinct from the idempotent terminal `status='deleted'` path
 * (which still returns the prior terminal envelope as success) and
 * from `StorageArtifactNotFoundError` (missing / cross-user). Route
 * maps this to HTTP 409 `delete_in_flight` with `retryable=true` so
 * the caller knows the action isn't fatal — just contended — and a
 * later retry will either find the row `deleted` (idempotent
 * success) or re-claim it (if the other caller's attempt failed
 * and the row transitioned to `delete_failed`).
 */
export class ArtifactDeleteInFlightError extends Error {
  readonly artifactId: string;
  readonly currentStatus: string;
  constructor(artifactId: string, currentStatus: string) {
    super(
      `delete_in_flight: artifact '${artifactId}' is currently being ` +
        `deleted by another caller (status='${currentStatus}')`,
    );
    this.name = 'ArtifactDeleteInFlightError';
    this.artifactId = artifactId;
    this.currentStatus = currentStatus;
  }
}
