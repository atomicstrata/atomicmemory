/**
 * Document service — Phases 1 and 2 of the large-file ingestion plan.
 *
 * Phase 1: pointer-only registry (register / get / list / delete).
 * Phase 2: text indexing — `indexText` chunks supplied text, embeds
 * the chunks via the existing core embedding stack, persists chunks to
 * `document_chunks`, and writes one provenance-linked memory per chunk
 * so `/v1/memories/search` can retrieve them. Implementation lives in
 * `document-indexer.ts`; this service is a thin facade.
 *
 * Schema validation lives in `src/schemas/documents.ts`; this service
 * trusts the validated input shape and only enforces the Phase 1
 * storage-mode invariant defensively (so direct in-process callers
 * can't bypass the Zod gate). No managed blob storage, no fact
 * extraction — those are Phase 3+.
 *
 * See `the large-file ingestion design notes`.
 */

import type pg from 'pg';
import {
  getRawDocumentById,
  listRawDocuments,
  registerRawDocument,
  upsertRawSource,
} from '../db/raw-document-repository.js';
import {
  listDocumentsForUser,
  listDocumentsWithoutMemoriesForUser,
  type DocumentRecoveryStatusFilter,
  type ListDocumentsForUserInput,
  type ListDocumentsForUserResult,
  type ListDocumentsWithoutMemoriesInput,
} from '../db/document-list-repository.js';
import {
  listPassportFeed,
  type ListPassportFeedInput,
  type ListPassportFeedResult,
} from '../db/passport-feed-repository.js';
import { decodeListCursor } from '../db/document-list-cursor.js';
import {
  listOrphanedManagedBlobsForDocument,
  type ManagedBlobRefRow,
} from '../db/raw-document-blob-repository.js';
import { softDeleteDocumentCascade } from '../db/repository-document-delete.js';
import { cleanupManagedBlobs, ManagedBlobCleanupError } from '../storage/cleanup.js';
import {
  buildRawStorageCleanupFailureEnvelope,
  markCleanupFailedAndSyncArtifact,
  markCleanupSuccessAndSyncArtifact,
} from '../db/raw-doc-artifact-sync.js';
import {
  singleStoreRegistry,
  type RawContentStoreRegistry,
} from '../storage/store-registry.js';
import type {
  ListRawDocumentsInput,
  RawDocumentRow,
  RawStorageMode,
} from '../db/raw-document-types.js';
import {
  indexDocumentText,
  type IndexDocumentInput,
  type IndexDocumentResult,
} from './document-indexer.js';
import {
  uploadRawDocument,
  type UploadRawInput,
  type UploadRawResult,
} from './document-upload.js';
import {
  markExtractionFailure as markExtractionFailureCore,
  markIndexFailure as markIndexFailureCore,
  type MarkerInput,
  type MarkerResult,
} from './document-failure-markers.js';
import { emitFilecoinEvent } from './filecoin-observability.js';
import type {
  UploadConfig,
  UploadConfigPointerOnly,
} from './upload-config.js';
import type { RawContentStore } from '../storage/raw-content-store.js';
import type { RawContentCodec } from '../storage/raw-content-codec.js';
import { NoopRawContentCodec } from '../storage/codecs/noop-codec.js';
import type {
  ExtractionErrorCode,
  IndexErrorCode,
} from '../schemas/documents.js';

const PHASE_1_STORAGE_MODE: RawStorageMode = 'pointer_only';

/**
 * Inputs to `register`. Mirrors the camelCase shape produced by
 * `RegisterDocumentBodySchema.transform()`.
 */
export interface RegisterDocumentInput {
  userId: string;
  sourceSite: string;
  provider: string;
  externalId: string;
  accountId: string | null;
  externalUri: string | null;
  displayName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  providerVersion: string | null;
  sourceModifiedAt: Date | null;
  storageMode: RawStorageMode;
  retentionPolicy: Record<string, unknown>;
  consentPolicy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /**
   * Phase B — optional restricted-initial-state status fields. Default
   * to `'not_required'` at the repository layer when omitted, matching
   * the column defaults. Service-owned values (`'running'` /
   * `'complete'` / `'failed'`) are blocked at the schema layer.
   */
  extractionStatus?: 'pending' | 'not_required' | 'unsupported';
  semanticIndexStatus?: 'pending' | 'not_required';
}

export interface RegisterDocumentResult {
  document: RawDocumentRow;
  created: boolean;
}

export interface DeleteDocumentResult {
  success: true;
  alreadyDeleted: boolean;
}

/** Optional dependencies injected at composition time. */
export interface DocumentServiceOptions {
  /** Phase 3 raw-content adapter. `null` when `rawStorageMode='pointer_only'`. */
  rawContentStore?: RawContentStore | null;
  /**
   * Phase 4a registry that dispatches cleanup by per-row provider.
   * Defaults to a single-store registry wrapping `rawContentStore`
   * (the pre-Phase-4a behavior); composition-root code passes a
   * multi-provider registry when `RAW_STORAGE_LEGACY_PROVIDERS` is
   * set.
   */
  storeRegistry?: RawContentStoreRegistry;
  /**
   * Phase 5 content codec injected around `store.put()`/`get()`.
   * Defaults to the noop codec for backcompat with pre-Phase-5 test
   * contexts; production composition supplies the codec configured
   * by `RAW_CONTENT_CODEC` (noop or aes_gcm).
   */
  codec?: RawContentCodec;
  /**
   * Subset of RuntimeConfig the service needs at runtime. Modeled
   * as a discriminated union so a pointer-only deployment cannot
   * leak a placeholder secret into service code: pointer_only
   * carries NO `storageKeyHmacSecret` (it's never derived); only
   * the managed_blob variant requires the HMAC secret.
   */
  config?: UploadConfig;
}

const DEFAULT_UPLOAD_CONFIG: UploadConfigPointerOnly = {
  rawStorageMode: 'pointer_only',
  rawStoragePrefix: '',
};

/**
 * Document service. Phase 1 covers register/get/list/delete; Phase 2
 * adds `indexText`; Phase 3 adds `uploadRaw` (managed-blob storage).
 * The Phase-3 dependencies (`rawContentStore`, raw-storage config) are
 * optional so existing test contexts that only need pointer-only
 * registration don't have to thread the new wiring.
 */
export class DocumentService {
  private readonly rawContentStore: RawContentStore | null;
  private readonly storeRegistry: RawContentStoreRegistry;
  private readonly codec: RawContentCodec;
  private readonly uploadConfig: UploadConfig;

  constructor(private readonly pool: pg.Pool, options: DocumentServiceOptions = {}) {
    this.rawContentStore = options.rawContentStore ?? null;
    this.storeRegistry = options.storeRegistry ?? singleStoreRegistry(this.rawContentStore);
    this.codec = options.codec ?? new NoopRawContentCodec();
    this.uploadConfig = options.config ?? DEFAULT_UPLOAD_CONFIG;
  }

  /**
   * Per-row provider dispatch registry. Exposed so the route layer's
   * Phase 7a formatters can resolve `delete_semantics` from each
   * row's `storage_provider` without rebuilding the registry. The
   * registry is read-only at the route boundary.
   */
  getStoreRegistry(): RawContentStoreRegistry {
    return this.storeRegistry;
  }

  /**
   * Idempotently register a document pointer. Looks up (or inserts) the
   * matching `raw_sources` row, then registers the document.
   *
   * Returns `{ document, created }` where `created = false` when an
   * active row already existed for the (user, source, external_id,
   * provider_version) namespace (route handler maps that to a 200; new
   * inserts map to 201).
   */
  async register(input: RegisterDocumentInput): Promise<RegisterDocumentResult> {
    assertPointerOnly(input.storageMode);

    const source = await upsertRawSource(this.pool, {
      userId: input.userId,
      sourceSite: input.sourceSite,
      provider: input.provider,
      accountId: input.accountId,
      storageMode: input.storageMode,
      retentionPolicy: input.retentionPolicy,
      consentPolicy: input.consentPolicy,
    });

    return registerRawDocument(this.pool, {
      userId: input.userId,
      rawSourceId: source.id,
      externalId: input.externalId,
      externalUri: input.externalUri,
      displayName: input.displayName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      contentHash: input.contentHash,
      providerVersion: input.providerVersion,
      sourceModifiedAt: input.sourceModifiedAt,
      storageMode: input.storageMode,
      metadata: input.metadata,
      extractionStatus: input.extractionStatus,
      semanticIndexStatus: input.semanticIndexStatus,
    });
  }

  /** Fetch one active document by id; null when missing/deleted/cross-user. */
  async get(userId: string, id: string): Promise<RawDocumentRow | null> {
    return getRawDocumentById(this.pool, userId, id);
  }

  /** List active documents for a user, optionally filtered by source_site. */
  async list(input: ListRawDocumentsInput): Promise<RawDocumentRow[]> {
    return listRawDocuments(this.pool, input);
  }

  /**
   * Phase D — cursor-paginated user-scoped document list with optional
   * recovery-status bucket filter. Distinct from {@link list} which uses
   * offset/limit + source_site filter (kept for backwards
   * compatibility with `GET /v1/documents/list`). The route layer
   * decodes the opaque `cursor` query param via `decodeListCursor`
   * BEFORE calling this method, so a malformed cursor surfaces as 400
   * upstream rather than a 500 from the SQL layer.
   */
  async listForUser(
    input: ListForUserServiceInput,
  ): Promise<ListDocumentsForUserResult> {
    const decoded = input.cursor !== undefined
      ? decodeListCursor(input.cursor)
      : null;
    if (input.cursor !== undefined && decoded === null) {
      throw new InvalidDocumentListCursorError();
    }
    const repoInput: ListDocumentsForUserInput = {
      userId: input.userId,
      limit: input.limit,
      cursor: decoded,
      statusFilter: input.statusFilter,
    };
    return listDocumentsForUser(this.pool, repoInput);
  }

  /**
   * Phase D — list active documents WITHOUT non-deleted memories,
   * narrowed by the layer-aware recovery filter. Backs the
   * passport server-side merge document-only stream and the
   * `GET /v1/documents/without-memories` endpoint.
   */
  async listWithoutMemoriesForUser(
    input: ListWithoutMemoriesServiceInput,
  ): Promise<ListDocumentsForUserResult> {
    const decoded = input.cursor !== undefined
      ? decodeListCursor(input.cursor)
      : null;
    if (input.cursor !== undefined && decoded === null) {
      throw new InvalidDocumentListCursorError();
    }
    const repoInput: ListDocumentsWithoutMemoriesInput = {
      userId: input.userId,
      limit: input.limit,
      cursor: decoded,
      statusFilter: input.statusFilter,
    };
    return listDocumentsWithoutMemoriesForUser(this.pool, repoInput);
  }

  /**
   * Phase D — passport feed (data-layer grouped query). Backs
   * `GET /v1/documents/passport-feed`. The webapp's
   * `/api/context/passport` route consumes this as the memory-feed
   * stream of its server-side two-stream merge.
   *
   * Cursor decoding mirrors the other Phase D list facades; a
   * malformed cursor (incl. structurally-valid-but-non-server
   * sortAt) throws `InvalidDocumentListCursorError` so the route
   * layer maps it to 400 invalid_cursor.
   */
  async listPassportFeed(
    input: ListPassportFeedServiceInput,
  ): Promise<ListPassportFeedResult> {
    const decoded = input.cursor !== undefined
      ? decodeListCursor(input.cursor)
      : null;
    if (input.cursor !== undefined && decoded === null) {
      throw new InvalidDocumentListCursorError();
    }
    const repoInput: ListPassportFeedInput = {
      userId: input.userId,
      limit: input.limit ?? 50,
      cursor: decoded,
    };
    return listPassportFeed(this.pool, repoInput);
  }

  /**
   * Soft-delete one document together with its Phase 2 derived chunks
   * and provenance-linked memories, in one transaction with a per-doc
   * advisory lock. `alreadyDeleted = true` when the row was missing or
   * previously tombstoned — keeps DELETE idempotent.
   */
  async delete(userId: string, id: string): Promise<DeleteDocumentResult> {
    const { removed, blobs: freshBlobs } = await softDeleteDocumentCascade(this.pool, userId, id);
    // When the document was already tombstoned by a prior call but
    // its managed blob still needs cleanup (raw_storage_failed),
    // pick those orphans up here. Otherwise an `alreadyDeleted=true`
    // response would hide a still-orphaned blob.
    const blobs = freshBlobs.length > 0
      ? freshBlobs
      : await listOrphanedManagedBlobsForDocument(this.pool, userId, id);
    if (blobs.length > 0) {
      await this.runBlobCleanupOrThrow(userId, blobs);
    }
    return { success: true, alreadyDeleted: !removed };
  }

  /**
   * Run cleanup against `blobs`; on failure mark each failing row
   * `raw_storage_failed` and throw, on success flip the rows to the
   * terminal `blob_deleted` state so a future retry of `DELETE
   * /v1/documents/:id` short-circuits cleanly.
   */
  private async runBlobCleanupOrThrow(
    userId: string,
    blobs: ManagedBlobRefRow[],
  ): Promise<void> {
    const result = await cleanupManagedBlobs(this.storeRegistry, blobs);
    // Mark partial successes *before* surfacing the error so a retry
    // doesn't re-attempt cleanup on URIs that are already clean. Per
    // Phase 4a §1, the marker is chosen by the adapter's `semantics`
    // field — `'deleted'` writes `blob_deleted`, `'unpinned'` /
    // `'tombstoned'` write `blob_tombstoned`. Both terminal states
    // are clean; the orphan-lookup helpers skip both.
    //
    // Step 7 of the storage-sibling plan: each marker write is
    // paired with a sync onto the linked `storage_artifacts` row so
    // the artifact's `status` follows `raw_documents` through the
    // terminal state.
    for (const success of result.successes) {
      // Step 7 paired marker + artifact sync. Each `success` carries
      // its `rawDocumentId` (the cleanup blob-ref now threads the
      // source-row id) so we never disambiguate by URI.
      await markCleanupSuccessAndSyncArtifact(this.pool, {
        userId,
        rawDocumentId: success.rawDocumentId,
        storageUri: success.storageUri,
        semantics: success.semantics,
      });
      emitDeleteEvent(userId, success.storageProvider, success.semantics);
    }
    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        await markCleanupFailedAndSyncArtifact(this.pool, {
          userId,
          rawDocumentId: failure.rawDocumentId,
          lastError: buildRawStorageCleanupFailureEnvelope(
            failure.message, failure.storageProvider,
          ),
        });
      }
      throw new ManagedBlobCleanupError(result);
    }
  }

  /**
   * Phase 2 indexing entry point. Idempotent on byte-identical text
   * + current `chunker_version`; otherwise re-chunks (soft-deleting
   * the prior generation of chunks + derived memories first). The
   * heavy lifting lives in `document-indexer.ts`.
   */
  async indexText(input: IndexDocumentInput): Promise<IndexDocumentResult> {
    return indexDocumentText(this.pool, input);
  }

  /**
   * Phase 3 managed-blob upload. Throws `ManagedStorageDisabledError`
   * (→ 503) when the deployment runs `rawStorageMode='pointer_only'`,
   * `UploadDocumentNotFoundError` (→ 404) when the document is missing
   * or owned by a different user. Idempotent on byte-identical input.
   */
  async uploadRaw(input: UploadRawInput): Promise<UploadRawResult> {
    return uploadRawDocument(
      this.pool,
      this.rawContentStore,
      this.codec,
      this.uploadConfig,
      input,
    );
  }

  /**
   * Phase C constrained extraction-layer transition. See
   * `services/document-failure-markers.ts` for the full state-machine
   * docstring; this is a thin facade so route handlers can call into
   * the service the same way they do for `register` / `indexText` /
   * `uploadRaw`.
   */
  async markExtractionFailure(
    input: MarkerInput<ExtractionErrorCode>,
  ): Promise<MarkerResult> {
    return markExtractionFailureCore(this.pool, input);
  }

  /**
   * Phase C constrained semantic-index-layer transition.
   */
  async markIndexFailure(
    input: MarkerInput<IndexErrorCode>,
  ): Promise<MarkerResult> {
    return markIndexFailureCore(this.pool, input);
  }
}

/**
 * Phase D — input shape for {@link DocumentService.listForUser}.
 * Mirrors the camelCase output of `DocumentListRootQuerySchema` plus
 * the `statusFilter` keying the data-layer filter. The cursor is the
 * opaque base64 string the route received; service-level decoding
 * lets us emit a clean 400 on malformed cursors via
 * `InvalidDocumentListCursorError`.
 */
export interface ListForUserServiceInput {
  userId: string;
  limit?: number;
  cursor?: string;
  statusFilter?: 'failed' | 'unsupported' | 'pending' | 'all';
}

/**
 * Phase D — input shape for {@link DocumentService.listWithoutMemoriesForUser}.
 * Mirrors the camelCase output of `ListDocumentsWithoutMemoriesQuerySchema`.
 * `statusFilter` is the optional layer-aware override; the repository
 * applies the rev-18 recovery default when undefined.
 */
export interface ListWithoutMemoriesServiceInput {
  userId: string;
  limit?: number;
  cursor?: string;
  statusFilter?: DocumentRecoveryStatusFilter;
}

/**
 * Phase D — input shape for {@link DocumentService.listPassportFeed}.
 * Mirrors the camelCase output of `PassportFeedQuerySchema` from
 * `schemas/document-list-schemas.ts`.
 */
export interface ListPassportFeedServiceInput {
  userId: string;
  limit?: number;
  cursor?: string;
}

/**
 * Phase D — sentinel thrown by {@link DocumentService.listForUser}
 * when the supplied opaque cursor is malformed. Route handlers map
 * this to 400 with `error: 'invalid_cursor'`.
 */
export class InvalidDocumentListCursorError extends Error {
  constructor() {
    super('cursor: invalid base64 / malformed payload');
    this.name = 'InvalidDocumentListCursorError';
  }
}

/**
 * Phase 1 storage-mode invariant. The schema layer rejects non-pointer
 * modes with 400, so this only fires on direct in-process callers; when
 * it does, it's a contract violation and a 500 is the right outcome.
 */
function assertPointerOnly(mode: RawStorageMode): void {
  if (mode !== PHASE_1_STORAGE_MODE) {
    throw new Error(
      `DocumentService: storage_mode '${mode}' is not yet supported — Phase 1 implements pointer_only only`,
    );
  }
}

/**
 * Phase 8.5 — emit a delete-path observability event keyed to the
 * adapter's `semantics`. The event taxonomy is `filecoin.delete.*`
 * so we ONLY emit when the row's `storageProvider === 'filecoin'`
 * (review-fix HIGH 3); a hypothetical future immediate provider
 * with `'unpinned'` semantics (e.g. an S3-Glacier-style adapter)
 * would need its own provider-prefixed event name.
 *
 * `'deleted'` semantics (local_fs / s3) emits nothing — the
 * Filecoin event stream is for Filecoin-shaped lifecycle moments
 * only.
 */
function emitDeleteEvent(
  userId: string,
  storageProvider: string,
  semantics: 'deleted' | 'unpinned' | 'tombstoned',
): void {
  if (storageProvider !== 'filecoin') return;
  if (semantics === 'deleted') return;
  const name =
    semantics === 'tombstoned'
      ? 'filecoin.delete.tombstoned'
      : 'filecoin.delete.unpinned';
  emitFilecoinEvent(name, {
    userId,
    provider: storageProvider,
    statusAfter: 'blob_tombstoned',
  });
}
