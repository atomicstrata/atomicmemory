/**
 * @file Artifact-storage error classes.
 *
 * Instanceof-checkable error classes the SDK throws from
 * `client.storage.*` methods. v1 exports the class shapes only
 * — no message formatting magic.
 *
 * Why classes (not enums): callers can `catch (err)
 * { if (err instanceof ArtifactInUseError) { ... } }` without
 * pattern-matching on `error_code` strings, and bundled stack
 * traces survive code minification.
 */

/**
 * Base class for everything `client.storage.*` throws when the
 * server returns a typed error envelope. `errorCode` mirrors the
 * server's `error_code` field — opaque, snake_case, stable.
 */
export class StorageClientError extends Error {
  readonly errorCode: string;
  readonly status: number;
  readonly bodyText: string;
  constructor(args: {
    message: string;
    errorCode: string;
    status: number;
    bodyText: string;
  }) {
    super(args.message);
    this.name = 'StorageClientError';
    this.errorCode = args.errorCode;
    this.status = args.status;
    this.bodyText = args.bodyText;
  }
}

/**
 * Thrown when a capability the call assumes (range read, bundles,
 * `hash_verify` mode) isn't supported by the active backend.
 */
export class UnsupportedCapabilityError extends StorageClientError {
  readonly capability: string;
  constructor(args: {
    capability: string;
    message: string;
    bodyText: string;
  }) {
    super({
      message: args.message,
      errorCode: 'unsupported_capability',
      status: 400,
      bodyText: args.bodyText,
    });
    this.name = 'UnsupportedCapabilityError';
    this.capability = args.capability;
  }
}

/** Thrown when `get` / `head` / `delete` / `verify` cannot find the artifact. */
export class ArtifactNotFoundError extends StorageClientError {
  readonly artifactId: string;
  constructor(args: { artifactId: string; bodyText: string }) {
    super({
      message: `Storage artifact ${args.artifactId} not found`,
      errorCode: 'artifact_not_found',
      status: 404,
      bodyText: args.bodyText,
    });
    this.name = 'ArtifactNotFoundError';
    this.artifactId = args.artifactId;
  }
}

/**
 * Thrown when a default delete hits a referenced artifact. Server
 * returns 409 with `referenced_by_document_count`; callers can use
 * `?policy=with_documents` to cascade.
 */
export class ArtifactInUseError extends StorageClientError {
  readonly artifactId: string;
  readonly referencedByDocumentCount: number;
  constructor(args: {
    artifactId: string;
    referencedByDocumentCount: number;
    bodyText: string;
  }) {
    super({
      message:
        `Storage artifact ${args.artifactId} is referenced by ` +
        `${args.referencedByDocumentCount} document(s); pass ` +
        `'policy: \"with_documents\"' to cascade`,
      errorCode: 'artifact_in_use',
      status: 409,
      bodyText: args.bodyText,
    });
    this.name = 'ArtifactInUseError';
    this.artifactId = args.artifactId;
    this.referencedByDocumentCount = args.referencedByDocumentCount;
  }
}

/**
 * Thrown when `getContent` targets a pointer-mode artifact. v1
 * pointers are metadata-only — the server NEVER proxies external
 * bytes. Caller must fetch the URI directly.
 */
export class PointerContentNotManagedError extends StorageClientError {
  readonly artifactId: string;
  readonly uri: string;
  constructor(args: { artifactId: string; uri: string; bodyText: string }) {
    super({
      message:
        `Artifact ${args.artifactId} is pointer-mode; fetch the URI ` +
        `directly (the server does not proxy pointer content)`,
      errorCode: 'pointer_content_not_managed',
      status: 409,
      bodyText: args.bodyText,
    });
    this.name = 'PointerContentNotManagedError';
    this.artifactId = args.artifactId;
    this.uri = args.uri;
  }
}

/**
 * Thrown when a managed put against a Filecoin backend hits the v1
 * carve-out (direct Filecoin uploads require artifact reconciliation,
 * which is not implemented yet). Callers can use document ingestion
 * (`PUT /v1/documents/:id/raw`) or pointer mode against Filecoin.
 */
export class FilecoinDirectStorageNotSupportedError extends StorageClientError {
  constructor(args: { bodyText: string }) {
    super({
      message:
        'Direct Filecoin artifact uploads are not supported in this ' +
        'version. Use document ingestion or pointer mode.',
      errorCode: 'filecoin_direct_storage_not_yet_supported',
      status: 501,
      bodyText: args.bodyText,
    });
    this.name = 'FilecoinDirectStorageNotSupportedError';
  }
}
