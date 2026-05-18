/**
 * @file Adapter exposing an existing `RawContentStore` as a `StorageBackend`.
 *
 * Step 5 of the storage-sibling plan — adapter, not rewrite. The
 * existing `local_fs`, `s3`, and (excluded-from-direct-uploads)
 * `filecoin` adapters keep their `RawContentStore` shape; this
 * adapter narrows their surface to the smaller `StorageBackend`
 * contract the storage service depends on.
 *
 * Hash semantics for v1 direct API:
 *   * `local_fs` / `s3` write identity-codec bytes — `plaintextHash`
 *     equals `storedHash` and equals the adapter's returned
 *     `contentHash` (SHA-256 of the bytes the adapter persisted).
 *   * `filecoin` direct managed upload is 501 in v1 and never
 *     reaches this adapter, so we do NOT need to model ciphertext
 *     hash divergence here.
 */

import type {
  RawContentStore,
  RawContentMetadata,
} from './raw-content-store.js';
import type {
  DeleteBackendResult,
  GetBackendResult,
  HeadBackendResult,
  PutBackendInput,
  PutBackendResult,
  StorageBackend,
} from './storage-backend.js';

export class RawContentStoreBackendAdapter implements StorageBackend {
  readonly provider: string;
  private readonly store: RawContentStore;
  constructor(store: RawContentStore) {
    this.store = store;
    this.provider = store.provider;
  }

  async put(input: PutBackendInput): Promise<PutBackendResult> {
    const stored = await this.store.put({
      key: input.key,
      body: input.body,
      contentType: input.contentType,
    });
    return {
      uri: stored.storageUri,
      sizeBytes: stored.sizeBytes,
      // v1 direct API runs identity codec only (Filecoin is 501);
      // the adapter's returned `contentHash` is the SHA-256 of the
      // exact bytes the caller passed.
      plaintextHash: stored.contentHash,
      storedHash: stored.contentHash,
      providerMetadata: stored.providerMetadata,
    };
  }

  async get(uri: string): Promise<GetBackendResult> {
    const result = await this.store.get(uri);
    return {
      body: result.body,
      contentType: result.metadata.contentType,
      sizeBytes: result.metadata.contentLength,
    };
  }

  async head(uri: string): Promise<HeadBackendResult> {
    const result = await this.store.head(uri);
    return {
      exists: result.exists,
      sizeBytes: extractContentLength(result.metadata),
      contentType: result.metadata?.contentType ?? null,
    };
  }

  async delete(uri: string): Promise<DeleteBackendResult> {
    const result = await this.store.delete(uri);
    return { deleted: result.deleted, semantics: result.semantics };
  }
}

function extractContentLength(metadata: RawContentMetadata | null): number | null {
  if (metadata === null) return null;
  return metadata.contentLength;
}
