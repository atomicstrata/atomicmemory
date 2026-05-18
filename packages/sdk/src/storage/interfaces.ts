/**
 * @file `StorageClient` interface — the public contract for the
 * SDK's `client.storage.*` namespace.
 *
 * The concrete implementation (`ConcreteStorageClient`) lives in
 * `./client.ts`. Defining the interface in its own module lets
 * downstream packages (webapp-sdk) depend on the stable contract
 * without pulling in the runtime transport — useful for testing
 * and for code that wraps the client with extra policy.
 *
 * v1 storage API is server-side only — see the OSS SDK README +
 * the architecture doc for the auth-boundary contract.
 */

import type {
  ArtifactBody,
  ArtifactHead,
  ArtifactRef,
  DeleteArtifactOptions,
  DeleteArtifactResult,
  PutArtifactInput,
  StorageCapabilities,
  StoredArtifact,
  VerificationResult,
  VerifyArtifactOptions,
} from './types.js';

/**
 * The storage client exposed via `AtomicMemoryClient.storage`. v1
 * SDK is server-side only (Node `fetch`).
 */
export interface StorageClient {
  /** Discover what the active direct-storage backend supports. */
  capabilities(): Promise<StorageCapabilities>;

  /** Store a pointer or bytes. Pointer mode is metadata-only;
   * managed mode uploads bytes through the configured backend. */
  put(input: PutArtifactInput): Promise<StoredArtifact>;

  /** Fetch a single artifact's metadata as JSON. Does NOT return bytes. */
  get(ref: ArtifactRef): Promise<StoredArtifact>;

  /** Fetch the artifact's bytes (managed-mode only — pointer-mode throws). */
  getContent(ref: ArtifactRef): Promise<ArtifactBody>;

  /** Cheap metadata probe via HTTP HEAD; returns status + size + provider. */
  head(ref: ArtifactRef): Promise<ArtifactHead>;

  /** Soft-delete an artifact + (optionally) cascade to documents. */
  delete(
    ref: ArtifactRef,
    options?: DeleteArtifactOptions,
  ): Promise<DeleteArtifactResult>;

  /** Run the backend's verification (CID match, provider proof, etc.). */
  verify(
    ref: ArtifactRef,
    options?: VerifyArtifactOptions,
  ): Promise<VerificationResult>;
}
