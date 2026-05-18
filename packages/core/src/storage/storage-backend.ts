/**
 * @file Backend abstraction the storage service writes through.
 *
 * Step 5 of the storage-sibling plan. Adapter, not rewrite: existing
 * `RawContentStore` providers (`local_fs`, `s3`, `filecoin`) stay
 * intact; `raw-content-store-backend-adapter.ts` exposes them as a
 * `StorageBackend` for the storage service so the service never
 * needs to know which adapter shape it is talking to.
 *
 * The backend handles managed-mode I/O only. Pointer-mode artifacts
 * are metadata-only and live entirely in the database — the storage
 * service NEVER calls a backend method against a pointer URI.
 */

/**
 * Concrete result of a `put` against a managed backend. The service
 * persists every field on the `storage_artifacts` row.
 */
export interface PutBackendResult {
  /** Adapter-returned URI we persist on `storage_artifacts.uri`. */
  uri: string;
  /** Bytes actually persisted. Equals the input body length. */
  sizeBytes: number;
  /**
   * Plaintext SHA-256 of the caller bytes. For the `identity` codec
   * (v1 default for `local_fs` and `s3`) this equals `storedHash`.
   * Always computed; exposed on the wire only when the caller opted
   * into `disclose_content_hash` at put time.
   */
  plaintextHash: string;
  /**
   * SHA-256 of the bytes the adapter actually wrote. For the
   * `aes_gcm` codec this is the ciphertext hash (Filecoin lifecycle)
   * and is NEVER on the wire. v1 keeps Filecoin direct uploads
   * behind a 501, so identity-codec equality is the typical case.
   */
  storedHash: string;
  /** Free-form provider sidecar; the service redacts before exposing. */
  providerMetadata: Record<string, unknown>;
}

export interface PutBackendInput {
  /** Owner-namespaced storage key (e.g. `s/<hmac-hex32>/<artifact-id>.bin`). */
  key: string;
  body: Buffer;
  contentType: string;
}

export interface GetBackendResult {
  body: Buffer;
  contentType: string | null;
  sizeBytes: number;
}

export interface HeadBackendResult {
  exists: boolean;
  sizeBytes: number | null;
  contentType: string | null;
}

export interface DeleteBackendResult {
  /** `true` when bytes were removed; `false` for already-missing keys. */
  deleted: boolean;
  /**
   * What the adapter's `delete` did at the provider boundary:
   *   - `'deleted'`     — `local_fs` / `s3` removed the object.
   *   - `'unpinned'`    — provider supports unpin-only (Filecoin).
   *   - `'tombstoned'`  — decentralized network: we stopped managing
   *                       the bytes but the network may still serve.
   * Drives the cleanup-side terminal raw_storage_status selection
   * (`blob_deleted` vs `blob_tombstoned`) and the artifact-delete
   * cascade in `StorageService.deleteArtifact`.
   */
  semantics: 'deleted' | 'unpinned' | 'tombstoned';
}

/**
 * Provider-agnostic managed-storage I/O surface the service depends
 * on. Adapters live alongside this file (`raw-content-store-backend-adapter.ts`).
 */
export interface StorageBackend {
  /** Provider id; matches `RawContentStore.provider`. */
  readonly provider: string;
  put(input: PutBackendInput): Promise<PutBackendResult>;
  get(uri: string): Promise<GetBackendResult>;
  head(uri: string): Promise<HeadBackendResult>;
  delete(uri: string): Promise<DeleteBackendResult>;
}
