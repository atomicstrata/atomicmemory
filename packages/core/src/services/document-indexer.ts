/**
 * Document indexer (Phase 2 + Phase B hardening).
 *
 * Takes a registered document + a body of text, deterministically
 * chunks it, embeds every chunk in one batch via the existing core
 * `embedTexts` helper, persists chunks to `document_chunks`, and writes
 * one row per chunk into `memories` with `raw_document_id` +
 * `document_chunk_id` provenance set so the existing
 * `/v1/memories/search` retrieval pipeline finds them.
 *
 * Phase B (rev-18 plan, Phase B section "document-indexer.ts") rewrote
 * the flow so it cannot leave a row in a stuck pending/running state:
 *
 *   1. Schema validation — type check only, no row touched (`IndexInputError` → 400).
 *   2. Open transaction, take per-document advisory lock, load row.
 *   3. Idempotent / re-index short-circuits BEFORE marking running:
 *        - `'complete'` + same `indexed_content_hash` → COMMIT, return idempotent skip.
 *        - `'complete'` + different hash → fall through; the conditional
 *          UPDATE below moves the row through 'running' and the existing
 *          `clearPriorGeneration` path replaces chunks atomically.
 *   4. Atomic conditional UPDATE → `'running'` (CAS). Only fires when
 *      `semantic_index_status IN ('pending','failed','stale','complete')`;
 *      `'running'` (concurrent writer) and `'not_required'` (registered
 *      not-to-index) yield rowCount=0 → ROLLBACK + 409.
 *   5. Known-document semantic validation: text-too-large / empty bodies
 *      ROLLBACK the running write, then write durable `'failed'` from
 *      a fresh statement so direct SDK callers cannot leave a stuck
 *      pending row.
 *   6. Prepare chunks (chunkText + embedTexts), persist inside the same
 *      transaction, mark `'complete'` + clear `last_error.semantic_index`,
 *      COMMIT.
 *
 * Visibility note: the `'running'` state is written *inside* the
 * BEGIN..COMMIT transaction, so under READ COMMITTED isolation other
 * connections never observe it — the row reads as the prior committed
 * state until COMMIT, at which point the row reads as `'complete'`
 * (success) or — after the catch-path fresh-tx write — `'failed'`. The
 * `'running'` value exists for the conditional-UPDATE concurrency
 * guard, not as a UI state. UI rendering of "indexing in progress"
 * requires a future async-worker design that commits `'running'`
 * before doing the work, with a lease/heartbeat (out of scope; see
 * the rev-18 "Out of scope" section).
 *
 * Idempotency contract (preserved): a re-index with byte-identical text
 * under the current `chunker_version` is a no-op (no fresh chunks, no
 * fresh memories, `indexed_content_hash` unchanged). A re-index with
 * new text soft-deletes the prior chunk + memory generation in
 * user-scope before inserting the fresh one. Retry from
 * `semantic_index_status='failed'` proceeds normally (no skip), clears
 * `last_error`, and lands `'complete'`.
 */

import pg from 'pg';
import { embedTexts } from './embedding.js';
import {
  PHASE2_CHUNKER_VERSION,
  PHASE2_PARSER_VERSION,
  chunkText,
  hashIndexedText,
  type ChunkOptions,
  type ChunkResult,
} from './document-chunker.js';
import {
  countActiveChunksForDocument,
  insertDocumentChunks,
  softDeleteChunksForDocument,
} from '../db/document-chunk-repository.js';
import type { DocumentChunkRow, InsertDocumentChunkInput } from '../db/document-chunk-types.js';
import {
  getDocumentWithSourceSite,
  setRawDocumentIndexedHashWithClient,
} from '../db/raw-document-repository.js';
import {
  buildLastError,
  markSemanticIndexStatus,
} from '../db/raw-document-status-repository.js';
import type {
  RawDocumentRow,
  SemanticIndexStatus,
} from '../db/raw-document-types.js';
import { softDeleteMemoriesForDocument, storeMemoryWithClient } from '../db/repository-write.js';
import { MAX_INDEX_TEXT_BYTES } from '../schemas/documents.js';

export interface IndexDocumentInput {
  userId: string;
  documentId: string;
  text: string;
  chunkOptions?: ChunkOptions;
}

export interface IndexDocumentResult {
  documentId: string;
  /**
   * SHA-256 of the indexed text under the current `chunker_version`.
   * Distinct from `RawDocumentRow.contentHash` (which is the
   * upstream/provider raw-content fingerprint) — both can co-exist on
   * the same document.
   */
  indexedContentHash: string;
  chunksCreated: number;
  memoriesCreated: number;
  /** True when the input text matched the prior indexed text and no work was done. */
  idempotentSkip: boolean;
  chunkerVersion: string;
  parserVersion: string;
}

/** Document not found / not owned by user. Routes map to 404. */
export class DocumentNotFoundError extends Error {
  constructor(public readonly documentId: string) {
    super(`document ${documentId} not found`);
    this.name = 'DocumentNotFoundError';
  }
}

/**
 * Schema-level (pre-document) input failure. Routes map to 400; no
 * row update fires because the document hasn't been loaded yet (and
 * may not even exist).
 */
export class IndexInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexInputError';
  }
}

/**
 * Phase B — the conditional UPDATE that moves
 * `semantic_index_status` to `'running'` returned rowCount=0. The
 * row is in a state that does not allow indexing (`'running'`
 * concurrent writer, `'not_required'`, or vanished between load
 * and the CAS write). Routes map to 409.
 */
export class IndexInvalidStateError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly currentStatus: SemanticIndexStatus,
  ) {
    super(
      `document ${documentId} is in semantic_index_status='${currentStatus}'; ` +
        `indexing not permitted from this state`,
    );
    this.name = 'IndexInvalidStateError';
  }
}

/**
 * Phase B — known-document semantic validation failure. Thrown after
 * the row has been loaded and the running CAS has fired, so the
 * indexer's catch path writes durable `semantic_index_status='failed'`
 * + `last_error` BEFORE rethrowing. Routes map to 413/400 with the
 * `documentId` echoed in the body so callers can navigate to the
 * failed row's detail view.
 */
export type IndexSemanticValidationCode = 'index_text_too_large' | 'extraction_empty';

export class IndexSemanticValidationError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly code: IndexSemanticValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'IndexSemanticValidationError';
  }
}

interface PreparedChunks {
  chunks: ChunkResult[];
  embeddings: number[][];
}

/**
 * Run the full index path. See file docstring for the six-phase
 * structure. The `pool` is used to check out one client for the
 * mutation transaction; failure markers ride a fresh statement on the
 * same pool so they survive the rollback.
 */
export async function indexDocumentText(
  pool: pg.Pool,
  input: IndexDocumentInput,
): Promise<IndexDocumentResult> {
  // Phase 1 — schema validation. Pure type check; Zod already
  // enforces this at the route boundary, but in-process callers
  // (tests, future workers) reach here directly and we don't want to
  // accept anything but a string.
  validateInput(input);
  const newHash = hashIndexedText(input.text);
  return runIndexFlow(pool, input, newHash);
}

// ---------------------------------------------------------------------------
// Phase 1 — schema validation, no DB state on the line.
// ---------------------------------------------------------------------------

function validateInput(input: IndexDocumentInput): void {
  if (typeof input.text !== 'string') {
    throw new IndexInputError('text must be a string');
  }
}

// ---------------------------------------------------------------------------
// Phase 5 helper — known-document semantic validation. Thrown errors
// trigger the catch path's fresh-tx 'failed' marker write so direct
// SDK callers don't leave a stuck pending row.
// ---------------------------------------------------------------------------

function semanticValidate(documentId: string, text: string): void {
  if (text.trim().length === 0) {
    throw new IndexSemanticValidationError(
      documentId,
      'extraction_empty',
      'text must contain non-whitespace content',
    );
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_TEXT_BYTES) {
    throw new IndexSemanticValidationError(
      documentId,
      'index_text_too_large',
      `text exceeds max size of ${MAX_INDEX_TEXT_BYTES} bytes (utf-8)`,
    );
  }
}

async function prepareChunks(input: IndexDocumentInput): Promise<PreparedChunks> {
  const chunks = chunkText(input.text, input.chunkOptions);
  if (chunks.length === 0) return { chunks, embeddings: [] };
  const embeddings = await embedTexts(chunks.map((c) => c.content), 'document');
  return { chunks, embeddings };
}

// ---------------------------------------------------------------------------
// Phase 2-6 orchestration. Single BEGIN/COMMIT, advisory-lock-serialized
// per document. Catch-path writes durable `semantic_index_status='failed'`
// from a fresh statement after ROLLBACK so the failure is observable
// even though the in-tx 'running' marker is reverted.
// ---------------------------------------------------------------------------

async function runIndexFlow(
  pool: pg.Pool,
  input: IndexDocumentInput,
  newHash: string,
): Promise<IndexDocumentResult> {
  const client = await pool.connect();
  let knownDocument = false;
  let caughtError: unknown = null;
  try {
    await client.query('BEGIN');
    await acquirePerDocumentLock(client, input.documentId);
    const loaded = await getDocumentWithSourceSite(client, input.userId, input.documentId);
    if (!loaded) {
      // Phase 2 — 404 short-circuit; no row to mark failed. ROLLBACK
      // happens in the outer catch.
      throw new DocumentNotFoundError(input.documentId);
    }
    knownDocument = true;
    const { document, sourceSite } = loaded;

    // Phase 3 — idempotent / re-index short-circuits BEFORE marking
    // running. complete + same-hash is a no-op; complete + different
    // hash falls through to the conditional UPDATE below.
    const idempotent = await maybeIdempotentSkip(client, document, newHash);
    if (idempotent) {
      await client.query('COMMIT');
      return idempotent;
    }

    // Phase 4 — atomic conditional UPDATE → 'running'.
    const casOk = await tryAdvanceToRunning(client, document.userId, document.id);
    if (!casOk) {
      // Re-load the row to surface the current state in the 409.
      // Cannot fail the row from this branch — `'running'` belongs to
      // another writer; clobbering its status would corrupt their flow.
      const stale = await getDocumentWithSourceSite(client, input.userId, input.documentId);
      const currentStatus =
        stale?.document.semanticIndexStatus ?? document.semanticIndexStatus;
      throw new IndexInvalidStateError(input.documentId, currentStatus);
    }

    // Phase 5 — known-document semantic validation. Throws here trigger
    // the outer catch, which writes durable 'failed' from a fresh tx.
    semanticValidate(input.documentId, input.text);

    // Phase 6 — prepare chunks (chunk + embed) + persist + mark complete.
    const prepared = await prepareChunks(input);
    const result = await applyIndexInsideTx(client, document, sourceSite, newHash, prepared);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    caughtError = err;
    await client.query('ROLLBACK').catch(() => undefined);
  } finally {
    client.release();
  }
  // Marker writes run AFTER `client.release()` so the
  // single-connection test pool can hand the connection out to
  // the marker's `pool.query` (see `db/pool.ts` — pgvector HNSW
  // index serialization requires `max=1` in tests; a marker call
  // with the original client still checked out would deadlock).
  if (knownDocument) {
    await markIndexerFailureBestEffort(pool, input.userId, input.documentId, caughtError);
  }
  throw caughtError;
}

/**
 * Per-document serialization. `pg_advisory_xact_lock` releases at COMMIT
 * or ROLLBACK; `hashtext($uuid)` collapses the UUID to a 32-bit key (good
 * enough for per-document mutex granularity).
 */
async function acquirePerDocumentLock(client: pg.PoolClient, documentId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
}

/**
 * Phase 4 — atomic CAS that flips the row to `'running'` only when
 * its current `semantic_index_status` is in the allowed start set.
 * Returns true on success (one row updated); false when the row is
 * `'running'` (concurrent writer), `'not_required'`, or vanished
 * between the load above and this UPDATE.
 *
 * Note that `'complete'` is in the allowed set: a re-index with new
 * content has already short-circuited the same-hash idempotent skip
 * above and lands here intentionally so chunks can be replaced.
 */
async function tryAdvanceToRunning(
  client: pg.PoolClient,
  userId: string,
  documentId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE raw_documents
        SET semantic_index_status = 'running',
            updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND deleted_at IS NULL
        AND semantic_index_status IN ('pending', 'failed', 'stale', 'complete')
      RETURNING id`,
    [documentId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Phase 3 helper — return an idempotent-skip result when the row's
 * recorded `indexed_content_hash` matches the incoming text and at
 * least one active chunk row exists for the current chunker_version.
 * Returns null when the caller should fall through to the running
 * CAS + chunk replacement path.
 */
async function maybeIdempotentSkip(
  client: pg.PoolClient,
  document: RawDocumentRow,
  newHash: string,
): Promise<IndexDocumentResult | null> {
  if (document.indexedContentHash !== newHash) return null;
  const existingChunkCount = await countActiveChunksForDocument(
    client,
    document.id,
    PHASE2_CHUNKER_VERSION,
  );
  if (existingChunkCount === 0) return null;
  return idempotentResult(document, newHash);
}

/**
 * Phase 6 — persist a fresh chunk + memory generation, mark
 * `semantic_index_status='complete'`, clear the semantic-index
 * `last_error`, and update `indexed_content_hash`. Runs inside the
 * caller's transaction; the COMMIT happens in `runIndexFlow`.
 */
async function applyIndexInsideTx(
  client: pg.PoolClient,
  document: RawDocumentRow,
  sourceSite: string,
  newHash: string,
  prepared: PreparedChunks,
): Promise<IndexDocumentResult> {
  await clearPriorGeneration(client, document.userId, document.id);
  if (prepared.chunks.length === 0) {
    await setRawDocumentIndexedHashWithClient(client, document.userId, document.id, newHash);
    await markSemanticIndexStatus({
      q: client,
      userId: document.userId,
      documentId: document.id,
      status: 'complete',
    });
    return makeResult(document, newHash, /* chunksCreated */ 0, /* memoriesCreated */ 0, false);
  }
  const chunkRows = await insertChunkRows(client, document, prepared);
  const memoriesCreated = await materializeMemories(client, document, sourceSite, chunkRows);
  await setRawDocumentIndexedHashWithClient(client, document.userId, document.id, newHash);
  await markSemanticIndexStatus({
    q: client,
    userId: document.userId,
    documentId: document.id,
    status: 'complete',
  });
  return makeResult(document, newHash, chunkRows.length, memoriesCreated, false);
}

/**
 * Best-effort `semantic_index_status='failed'` marker run on a fresh
 * pool statement after the indexer transaction has rolled back.
 * Skipped for `IndexInvalidStateError` (the row is owned by another
 * writer or in a state we shouldn't clobber).
 */
async function markIndexerFailureBestEffort(
  pool: pg.Pool,
  userId: string,
  documentId: string,
  err: unknown,
): Promise<void> {
  if (err instanceof IndexInvalidStateError) return;
  const code = classifyIndexerFailure(err);
  const message = err instanceof Error ? err.message : String(err);
  try {
    await markSemanticIndexStatus({
      q: pool,
      userId,
      documentId,
      status: 'failed',
      lastError: buildLastError('semantic_index', code, message),
    });
  } catch (markerErr) {
    console.error(
      `[document-indexer] semantic_index_status=failed marker write failed for documentId=${documentId}:`,
      markerErr,
    );
  }
}

function classifyIndexerFailure(err: unknown): string {
  if (err instanceof IndexSemanticValidationError) return err.code;
  return 'unknown';
}

async function clearPriorGeneration(
  client: pg.PoolClient,
  userId: string,
  documentId: string,
): Promise<void> {
  await softDeleteChunksForDocument(client, userId, documentId);
  await softDeleteMemoriesForDocument(client, userId, documentId);
}

async function insertChunkRows(
  client: pg.PoolClient,
  document: RawDocumentRow,
  prepared: PreparedChunks,
): Promise<DocumentChunkRow[]> {
  const inputs: InsertDocumentChunkInput[] = prepared.chunks.map((chunk, i) => ({
    userId: document.userId,
    rawDocumentId: document.id,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    contentHash: chunk.contentHash,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenCount: chunk.tokenCount,
    embedding: prepared.embeddings[i],
    parserVersion: PHASE2_PARSER_VERSION,
    chunkerVersion: PHASE2_CHUNKER_VERSION,
  }));
  return insertDocumentChunks(client, inputs);
}

async function materializeMemories(
  client: pg.PoolClient,
  document: RawDocumentRow,
  sourceSite: string,
  chunkRows: DocumentChunkRow[],
): Promise<number> {
  // Phase 4: thread the document's display metadata onto every derived
  // memory so downstream consumers (e.g. webapp Context Passport) can
  // render filename/mime without re-joining `raw_documents`. The
  // raw-document `metadata` JSONB is the document-author payload (e.g.
  // `{ filename, mimeType }` from the webapp upload route) — copied as
  // a base, then overlaid with first-class display columns
  // (`display_name`, `mime_type`) so the column values always win on
  // conflict. `type='user-context'` matches the existing
  // `storeContext` shape used by `/api/context/text` so passport
  // grouping logic stays uniform across both write paths.
  const documentMetadata = buildDocumentLevelMetadata(document);
  let count = 0;
  for (const chunk of chunkRows) {
    await storeMemoryWithClient(client, {
      userId: chunk.userId,
      content: chunk.content,
      embedding: chunk.embedding,
      importance: 0.5,
      sourceSite,
      sourceUrl: document.externalUri ?? '',
      rawDocumentId: chunk.rawDocumentId,
      documentChunkId: chunk.id,
      // Stamp the per-chunk id alongside the document-level fields so
      // SDK consumers that only read `memory.metadata` (rather than
      // the typed `raw_document_id` / `document_chunk_id` columns) can
      // still resolve provenance per chunk. Typed columns remain the
      // source of truth.
      metadata: { ...documentMetadata, document_chunk_id: chunk.id },
    });
    count++;
  }
  return count;
}

/**
 * Compose the document-level metadata fields attached to every
 * chunk-derived memory. Document-supplied `metadata` is the base;
 * first-class display fields (`display_name`, `mime_type`) override
 * on conflict so a malicious metadata payload cannot spoof the row's
 * real filename. `type='user-context'` defaults when the document
 * didn't declare one. The per-chunk `document_chunk_id` is added by
 * the caller so this helper stays document-scoped.
 */
function buildDocumentLevelMetadata(document: RawDocumentRow): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(document.metadata ?? {}) };
  if (document.displayName) base.filename = document.displayName;
  if (document.mimeType) base.mimeType = document.mimeType;
  if (base.type === undefined) base.type = 'user-context';
  base.raw_document_id = document.id;
  return base;
}

function idempotentResult(
  document: RawDocumentRow,
  newHash: string,
): IndexDocumentResult {
  return makeResult(document, newHash, 0, 0, /* idempotentSkip */ true);
}

function makeResult(
  document: RawDocumentRow,
  indexedContentHash: string,
  chunksCreated: number,
  memoriesCreated: number,
  idempotentSkip: boolean,
): IndexDocumentResult {
  return {
    documentId: document.id,
    indexedContentHash,
    chunksCreated,
    memoriesCreated,
    idempotentSkip,
    chunkerVersion: PHASE2_CHUNKER_VERSION,
    parserVersion: PHASE2_PARSER_VERSION,
  };
}
