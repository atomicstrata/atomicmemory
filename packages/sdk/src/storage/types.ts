/**
 * @file Storage artifact type definitions.
 *
 * Public types for the SDK's `client.storage.*` namespace. The
 * concrete `StorageClient` implementation lives in `./client.ts`
 * (`ConcreteStorageClient`); this file defines the shared shapes
 * both the interface and the runtime use. v1 SDK is server-side
 * only — see the README + the architecture doc for the
 * auth-boundary contract.
 *
 * Naming: the module subpath is `./storage` (storage artifacts are
 * the primary user-facing storage in the SDK). The legacy KV /
 * cache adapters live under `./kv-cache`.
 *
 * Field naming. The SDK is consistently camelCase on every public
 * surface. The wire contract (core HTTP API) remains snake_case;
 * `client.ts` is the single seam that translates incoming
 * snake_case to camelCase on read and serialises camelCase options
 * back to snake_case on write.
 */

/**
 * All identifier fields callers may use to address an artifact.
 * Exactly one is the canonical handle (`artifactId` in v1); the
 * others are informational. The exported `ArtifactRef` type
 * (below) requires AT LEAST ONE of these to be set.
 */
interface ArtifactRefFields {
  /** Server-assigned UUID — the canonical handle in v1. */
  artifactId?: string;
  /** Backend URI — informational; not used to dereference in v1. */
  uri?: string;
  /** Hash of caller bytes — informational; only set when the
   * artifact was put with `discloseContentHash: true`. */
  contentHash?: string;
}

/**
 * Requires at least one of the given keys on `T` to be present.
 * Compile-time enforcement of the "at least one identifier"
 * invariant on `ArtifactRef`.
 */
type RequireAtLeastOne<T, Keys extends keyof T = keyof T> =
  Pick<T, Exclude<keyof T, Keys>>
  & {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

/**
 * Stable reference to an artifact. At least one of `artifactId`,
 * `uri`, or `contentHash` must be set; in v1 the SDK always uses
 * `artifactId` for follow-up calls (`get` / `head` / `delete` /
 * `verify` / `getContent`).
 */
export type ArtifactRef = RequireAtLeastOne<ArtifactRefFields>;

/**
 * Closed lifecycle states a `StoredArtifact` can occupy.
 *
 * v1 status transitions:
 *   pointer-mode put         → 'stored' (immediate; no async lifecycle)
 *   managed put (immediate)  → 'stored'
 *   managed put (eventual)   → 'pending' → 'available' (via reconciler)
 *                                       ↘  'failed'
 *   delete                   → 'deleting' → 'deleted' | 'delete_failed'
 *
 * `unavailable` is reserved for future use (e.g. provider reports
 * the bytes are no longer retrievable but the row hasn't been
 * deleted) — never emitted in v1.
 */
export type StorageArtifactStatus =
  | 'stored'
  | 'pending'
  | 'available'
  | 'unavailable'
  | 'deleting'
  | 'deleted'
  | 'delete_failed'
  | 'failed';

export type StorageAddressingMode = 'location' | 'content' | 'provider_native';
export type StorageConsistency = 'immediate' | 'eventual';
export type StorageAvailabilityModel =
  | 'immediate'
  | 'delayed'
  | 'scheduled'
  | 'best_effort';
export type StorageDeleteSemantics =
  | 'delete'
  | 'unpin'
  | 'tombstone'
  | 'provider_retained';

/**
 * Lifecycle envelope on a `StoredArtifact`. Provider-agnostic
 * summary of availability + delete-semantics so callers can branch
 * without backend-specific imports.
 */
export interface StorageLifecycle {
  availability?: StorageAvailabilityModel;
  deleteSemantics?: StorageDeleteSemantics;
}

/** Optional replication state for content-addressed storage backends. */
export interface ReplicationState {
  desiredCopies?: number;
  confirmedCopies?: number;
}

/** Optional verification state — provider proofs, CID verification. */
export interface VerificationState {
  providerProofStatus?: 'pending' | 'verified' | 'failed' | 'unsupported';
  lastVerifiedAt?: string;
}

/** Optional retrieval-readiness state. */
export interface RetrievalState {
  status?:
    | 'not_checked'
    | 'retrievable'
    | 'not_retrievable'
    | 'unsupported';
  lastCheckedAt?: string;
}

/**
 * Result of `client.storage.put({ ... })` and `client.storage.get`.
 * Fully camelCase — the snake_case wire response is translated by
 * `client.ts`. `contentHash` is present ONLY when the caller
 * passed `discloseContentHash: true` AND the backend's
 * `supportsContentHash` capability is true.
 *
 * Privacy: the SDK NEVER receives a `stored_hash` field. Operators
 * who need provider-side byte-hash diagnostics consult the server
 * directly.
 */
export interface StoredArtifact {
  artifactId: string;
  provider: string;
  mode: 'pointer' | 'managed';
  /** Backend URI. Null for pending/failed managed artifacts. */
  uri: string | null;
  status: StorageArtifactStatus;
  sizeBytes: number | null;
  contentType: string | null;
  /** Plaintext SHA-256 of caller bytes — only present when opted in. */
  contentHash?: string;
  contentEncoding: 'identity' | 'aes_gcm';
  /** Provider-native identifiers (CID, pieceCid, etc.). Allowlisted server-side. */
  identifiers: Record<string, string>;
  lifecycle: StorageLifecycle;
  replication?: ReplicationState;
  verification?: VerificationState;
  retrieval?: RetrievalState;
  /** Allowlisted provider-specific public state (network, etc.). */
  providerDetails?: Record<string, unknown>;
  /** Caller-supplied metadata at put time (validated server-side). */
  metadata: Record<string, string | number | boolean>;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
}

/**
 * Discriminated `put` input. Pointer mode stores metadata only — the
 * server NEVER fetches the URI. Managed mode uploads bytes through
 * the configured backend.
 */
export type PutArtifactInput = PutPointerInput | PutManagedInput;

export interface PutPointerInput {
  mode: 'pointer';
  uri: string;
  contentType: string;
  sizeBytes?: number;
  contentHash?: string;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Managed-mode put input. v1 body types are known-length and
 * `ArrayBuffer`-backed: `Buffer | Uint8Array | ArrayBuffer`. Streams
 * (`ReadableStream`, Node `Readable`) are explicitly rejected by the
 * client until the Streaming + Resumable Uploads PR — the server
 * requires `Content-Length` and the client computes it from the
 * supplied bytes.
 *
 * `Blob` is intentionally NOT in the type. The runtime would have to
 * call `await blob.arrayBuffer()` internally to compute
 * `Content-Length`, which silently buffers the entire Blob in
 * memory. Callers that have a `Blob` should convert it explicitly
 * (`new Uint8Array(await blob.arrayBuffer())`) so the buffering is
 * visible at the call site.
 */
export interface PutManagedInput {
  mode: 'managed';
  body: Buffer | Uint8Array | ArrayBuffer;
  contentType: string;
  /** Opt in to receive `content_hash` (plaintext SHA-256) on the
   * response. Default false — hashes are privacy-sensitive,
   * especially with end-to-end encryption codecs. */
  discloseContentHash?: boolean;
  metadata?: Record<string, string | number | boolean>;
}

/** Result of `getContent` is a standard `fetch` Response. */
export type ArtifactBody = Response;

/** Result of `head` — JSON metadata projection of `StoredArtifact`. */
export type ArtifactHead = Pick<
  StoredArtifact,
  | 'artifactId'
  | 'provider'
  | 'mode'
  | 'status'
  | 'sizeBytes'
  | 'contentType'
>;

/**
 * Delete-policy enum. No `force` — orphan recovery is an ops-only
 * operation; callers must pass `policy: 'with_documents'` to cascade
 * a soft-delete to linked documents.
 */
export type DeleteArtifactPolicy = 'artifact_only' | 'with_documents';

export interface DeleteArtifactOptions {
  policy?: DeleteArtifactPolicy;
}

export interface DeleteArtifactResult {
  artifactId: string;
  status: StorageArtifactStatus;
  cascadedDocumentIds?: string[];
}

export interface VerifyArtifactOptions {
  /** Reserved for future verification depth choices. v1 ignores. */
  mode?: 'head_only' | 'hash_verify';
}

export type VerificationResult =
  | { kind: 'verified'; details?: Record<string, unknown> }
  | { kind: 'failed'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface ArtifactRange {
  start: number;
  end: number;
}

/**
 * Storage capabilities — describes what the **direct** storage API
 * (`/v1/storage/artifacts/*`) supports. Document ingestion has its
 * own capability surface at `/v1/documents/limits` and may report
 * different flags.
 *
 * `supportsContentHash` and `supportsContentAddressedUri` are
 * SEPARATE concerns: the former is byte-hash disclosure, the
 * latter is URI-as-hash.
 */
export interface StorageCapabilities {
  provider: string;
  addressing: StorageAddressingMode[];
  consistency: StorageConsistency;
  maxUploadBytes?: number;
  minUploadBytes?: number;
  supportsDirectUpload: boolean;
  supportsRangeRead: boolean;
  supportsDelete: boolean;
  supportsTombstone: boolean;
  supportsBundles: boolean;
  supportedBundleFormats: string[];
  supportsVerification: boolean;
  supportsProviderProofs: boolean;
  supportsReplication: boolean;
  supportsRetrievalStatus: boolean;
  /** Backend can return a SHA-256 of the caller bytes on opt-in. */
  supportsContentHash: boolean;
  /** Backend's URI IS the content hash (Filecoin only). */
  supportsContentAddressedUri: boolean;
  deleteSemantics: StorageDeleteSemantics[];
  availabilityModel: StorageAvailabilityModel;
}
