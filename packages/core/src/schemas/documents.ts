/**
 * @file Zod schemas for /v1/documents/*.
 *
 * Wire format is snake_case (matching /v1/memories/*); each schema
 * `.transform()`s to camelCase for handlers. Covers register
 * (pointer-only at the wire layer), index, raw upload, the
 * constrained-transition bodies, the query schemas in
 * `document-list-schemas.ts`, and the runtime preflight + path-param
 * helpers shared across the routes.
 *
 * Wire-layer mode invariant: `POST /v1/documents` (register) still
 * only accepts `storage_mode='pointer_only'`. The `managed_blob`
 * mode is populated server-side by the post-upload row-promotion in
 * `raw-document-blob-repository.ts:updateRawDocumentBlobStorageWithClient`
 * `inline_small_text` is reserved for a future inline-
 * text path and is rejected with a "not yet supported" message even
 * though the SQL CHECK accepts it.
 */

import { z } from './zod-setup.js';
import { makeUuidPathParamSchema, requiredStringBody, UUID_REGEX } from './common.js';

const MAX_METADATA_SERIALIZED_BYTES = 32 * 1024;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// Document-specific field schemas (shared helpers come from ./common.js)
// ---------------------------------------------------------------------------

/**
 * Optional string body field that also accepts an explicit `null`. Most
 * /v1/documents/* fields use this — they map to nullable Postgres columns
 * where the wire client wants to distinguish "absent" (do not change) from
 * "explicitly null" (clear the field).
 *
 * Modeled as a real `string | null | undefined` union so the generated
 * OpenAPI emits `type: ["string", "null"]` (3.1) instead of pretending
 * the field is string-only. Wire inputs that are neither string nor
 * null are rejected with a 400 from Zod — that's stricter than the
 * `OptionalBodyString` soft-coerce pattern, but the wire contract here
 * is genuinely nullable + brand new, so strictness is the right call.
 */
const OptionalNullableBodyString = z.string().nullable().optional();

const OptionalPositiveBigInt = z
  .unknown()
  .optional()
  .superRefine((v, ctx) => {
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      ctx.addIssue({ code: 'custom', message: 'size_bytes must be a non-negative integer' });
    }
  })
  .transform(v => (typeof v === 'number' ? v : undefined))
  .openapi({ type: 'integer', minimum: 0 });

const OptionalIsoTimestamp = z
  .unknown()
  .optional()
  .superRefine((v, ctx) => {
    if (v === undefined || v === null || v === '') return;
    if (typeof v !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'source_modified_at must be an ISO 8601 string' });
      return;
    }
    if (Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: 'custom', message: 'source_modified_at must be a valid ISO 8601 timestamp' });
    }
  })
  .transform(v => (typeof v === 'string' && v.length > 0 ? new Date(v) : undefined))
  .openapi({ type: 'string', format: 'date-time' });

/** storage_mode: only `pointer_only` is accepted on registration. */
const PointerOnlyStorageMode = z
  .unknown()
  .optional()
  .superRefine((v, ctx) => {
    if (v === undefined || v === null || v === 'pointer_only') return;
    if (v === 'managed_blob' || v === 'inline_small_text') {
      ctx.addIssue({
        code: 'custom',
        message: `storage_mode '${v}' is not supported by document registration; use pointer_only`,
      });
      return;
    }
    ctx.addIssue({ code: 'custom', message: 'storage_mode must be "pointer_only"' });
  })
  .transform(() => 'pointer_only' as const)
  .openapi({ type: 'string', enum: ['pointer_only'] });

/**
 * status-layer — restricted set of `extraction_status` values clients are
 * allowed to declare on register. Service-owned transitions handle
 * `'running'` / `'complete'` / `'failed'`; clients that try to
 * smuggle those values get a 400. The wire contract is uniform:
 * extraction-layer state changes flow through the upload pipeline
 * (failure-transition) and core-side endpoints, not through register-body
 * fields.
 */
const RegisterableExtractionStatus = z
  .enum(['pending', 'not_required', 'unsupported'])
  .openapi({
    type: 'string',
    enum: ['pending', 'not_required', 'unsupported'],
    description:
      'Initial extraction-layer state at register time. ' +
      "'pending' = caller intends to extract; 'not_required' = pointer-only flow " +
      "(default); 'unsupported' = caller knows the file type cannot be extracted. " +
      "Service-owned values ('running', 'complete', 'failed') are rejected.",
  });

/**
 * status-layer — restricted set of `semantic_index_status` values for
 * register-time declarations. The same trust model: clients may flag
 * a row as `'pending'` (the upload pipeline will index next) or
 * `'not_required'` (pointer-only / non-indexable). All transitions
 * to `'running'` / `'complete'` / `'failed'` are service-owned.
 */
const RegisterableSemanticIndexStatus = z
  .enum(['pending', 'not_required'])
  .openapi({
    type: 'string',
    enum: ['pending', 'not_required'],
    description:
      'Initial semantic-index-layer state at register time. ' +
      "'pending' = caller intends to index; 'not_required' = no indexing planned. " +
      "Service-owned transitions handle 'running', 'complete', 'failed', 'stale'.",
  });

const FreeFormJsonObject = z
  .record(z.string(), z.unknown())
  .openapi({ type: 'object', additionalProperties: true });

// ---------------------------------------------------------------------------
// POST /v1/documents — register
// ---------------------------------------------------------------------------

export const RegisterDocumentBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    source_site: requiredStringBody('source_site'),
    provider: requiredStringBody('provider'),
    external_id: requiredStringBody('external_id'),
    account_id: OptionalNullableBodyString,
    external_uri: OptionalNullableBodyString,
    display_name: OptionalNullableBodyString,
    mime_type: OptionalNullableBodyString,
    size_bytes: OptionalPositiveBigInt,
    content_hash: OptionalNullableBodyString,
    provider_version: OptionalNullableBodyString,
    source_modified_at: OptionalIsoTimestamp,
    storage_mode: PointerOnlyStorageMode,
    retention_policy: FreeFormJsonObject.optional(),
    consent_policy: FreeFormJsonObject.optional(),
    metadata: FreeFormJsonObject.optional(),
    extraction_status: RegisterableExtractionStatus.optional(),
    semantic_index_status: RegisterableSemanticIndexStatus.optional(),
  })
  // `last_error` is intentionally absent from the schema. Failure
  // envelopes are written by service-owned transitions only — accepting
  // them on register would let clients smuggle arbitrary failure state
  // onto a fresh row.
  .strict()
  .refine(metadataWithinSizeCap, {
    message: `metadata exceeds max serialized size of ${MAX_METADATA_SERIALIZED_BYTES} bytes (utf-8)`,
  })
  .transform(toRegisterDocumentInternal)
  .openapi({
    description:
      'Register a document pointer. Document registration accepts pointer_only mode; ' +
      'managed_blob and inline_small_text return 400.',
  });

export type RegisterDocumentBody = z.infer<typeof RegisterDocumentBodySchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const DocumentIdParamSchema = makeUuidPathParamSchema();

export type DocumentIdParam = z.infer<typeof DocumentIdParamSchema>;

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/**
 * Exported (private-by-convention) so the cursor-list query-schema module
 * (`document-list-schemas.ts`) can reuse the same wire contract for
 * the cursor-paginated routes without re-defining the helper.
 */
export const RequiredQueryString = z.string().min(1);

export const DocumentByIdQuerySchema = z
  .object({ user_id: RequiredQueryString })
  .transform(q => ({ userId: q.user_id }));

export type DocumentByIdQuery = z.infer<typeof DocumentByIdQuerySchema>;

export const ListDocumentsQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    source_site: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  })
  .transform(q => ({
    userId: q.user_id,
    sourceSite:
      typeof q.source_site === 'string' && q.source_site.length > 0 ? q.source_site : undefined,
    limit: clampInt(q.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT),
    offset: clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  }));

export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

// ---------------------------------------------------------------------------
// POST /v1/documents/:id/index — the upload implementation text indexing
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the indexed-text body. Deterministic (no env knob)
 * so the wire contract stays predictable: clients can size their
 * extracted-text payloads against a known fixed value.
 *
 * 25 MiB accommodates the webapp manual-upload pipeline, which allows
 * 50 MiB input files and feeds the *extracted* text (typically a
 * fraction of the source size — e.g. a 50 MiB PDF extracts to ≈ 5 MiB
 * of text).
 *
 * status-layer durable-failure contract: the indexer's `semanticValidate`
 * (in `services/document-indexer.ts`) is the authoritative gate for
 * whitespace-only and oversized-text inputs. Both checks fire AFTER
 * the document is loaded and the running CAS lands, so the row is
 * durably marked `semantic_index_status='failed'` + `last_error`
 * before the route returns 413/400. The route's body-parser limit
 * (`INDEX_BODY_PARSER_LIMIT` below) is a defense-in-depth bound that
 * lets a body containing exactly `MAX_INDEX_TEXT_BYTES` of text reach
 * the handler with reasonable JSON-wrapper headroom while still
 * rejecting truly multi-GB request bodies.
 *
 * `IndexDocumentBodySchema` deliberately does NOT refine on whitespace
 * or byte length — those are durable-failure checks owned by the
 * indexer. The schema only enforces structural shape (string fields
 * are present and typed correctly) so callers that send a malformed
 * body (no `user_id`, missing `text`, wrong type) still get a clean
 * pre-document-known 400 with no row touched.
 */
export const MAX_INDEX_TEXT_BYTES = 25 * 1024 * 1024;

/**
 * Per-route HTTP body-parser limit for `POST /v1/documents/:id/index`.
 * Adds a 64 KiB headroom on top of `MAX_INDEX_TEXT_BYTES` so a body
 * containing the cap-sized text plus the JSON wrapper
 * (`{"user_id":"<uuid>","text":"…"}`) and modest amounts of escape
 * encoding still fits. Truly huge request bodies (multi-GB scrape
 * dumps, malformed clients, attack payloads) still get rejected by
 * Express's body parser with 413 BEFORE the handler runs.
 *
 * Pathological JSON-escape encodings that double the encoded text
 * size will exceed this cap and surface as 413 from the body-parser
 * — that is the right behavior; the runtime semantic-validation
 * limit is on the parsed UTF-8 string, not the wire-encoded bytes,
 * and a caller can re-encode to fit.
 */
export const INDEX_BODY_PARSER_LIMIT = MAX_INDEX_TEXT_BYTES + 64 * 1024;

export const IndexDocumentBodySchema = z
  .object({
    user_id: requiredStringBody('user_id'),
    // status-layer: structural-only validation. Whitespace + byte-cap
    // checks are owned by `semanticValidate` in the indexer so the
    // failure transitions get persisted on the durable row instead
    // of leaving direct SDK callers with a stuck `pending` state.
    text: requiredStringBody('text'),
  })
  .transform((b) => ({
    userId: b.user_id,
    text: b.text,
  }))
  .openapi({
    description:
      'Chunk + embed the supplied text for the registered document, ' +
      'creating one provenance-linked memory per chunk. Idempotent on ' +
      'byte-identical text under the current chunker_version.',
  });

export type IndexDocumentBody = z.infer<typeof IndexDocumentBodySchema>;

// ---------------------------------------------------------------------------
// POST /v1/documents/:id/extraction-failure - failure-transition constrained transition
// ---------------------------------------------------------------------------

/**
 * failure-transition - bounded enum of extraction-layer failure codes accepted on
 * `POST /v1/documents/:id/extraction-failure`. The set deliberately
 * mirrors the audit's "things a parser does when it gives up" list;
 * adding a new code requires updating this enum AND the route's
 * `ExtractionErrorCode` SDK type so the wire stays in lockstep.
 */
const ExtractionErrorCodeSchema = z.enum([
  'parser_threw',
  'parser_timeout',
  'parser_oom',
  'unsupported_encoding',
  'corrupt_input',
  'unknown',
]).openapi({
  type: 'string',
  enum: ['parser_threw', 'parser_timeout', 'parser_oom', 'unsupported_encoding', 'corrupt_input', 'unknown'],
  description:
    'Bounded extraction-layer failure code. Open-ended exception messages ' +
    'ride on `error_message`; this code is what the UI / metrics layer ' +
    'pivots on.',
});

export type ExtractionErrorCode = z.infer<typeof ExtractionErrorCodeSchema>;

/**
 * failure-transition - request body for the constrained extraction-failure
 * transition. The route service-truncates / sanitises `error_message`
 * before persisting (see `sanitizeLastErrorMessage` +
 * `MAX_LAST_ERROR_MESSAGE_CHARS` in
 * `src/db/raw-document-status-repository.ts`); the schema enforces
 * upper-bound shape only. Service-owned status fields are NOT
 * accepted - clients can declare *that* extraction failed and *what
 * category*, but cannot put a document into arbitrary status
 * combinations.
 */
export const ExtractionFailureBodySchema = z.object({
  user_id: requiredStringBody('user_id'),
  error_code: ExtractionErrorCodeSchema,
  error_message: z.string(),
}).strict().transform((b) => ({
  userId: b.user_id,
  errorCode: b.error_code,
  errorMessage: b.error_message,
})).openapi({
  description:
    'Constrained transition body for the extraction-failure route. ' +
    'The route loads the row under a per-document advisory lock, ' +
    'verifies the current state is one of the allowed source states, ' +
    'and writes `extraction_status=\"failed\"` + ' +
    '`semantic_index_status=\"not_required\"` + a sanitised ' +
    '`last_error.layer=\"extraction\"`. 409 on invalid transitions; ' +
    'idempotent on repeat for already-failed rows.',
});

export type ExtractionFailureBody = z.infer<typeof ExtractionFailureBodySchema>;

// ---------------------------------------------------------------------------
// POST /v1/documents/:id/index-failure - failure-transition constrained transition
// ---------------------------------------------------------------------------

/**
 * failure-transition - bounded enum of semantic-index-layer failure codes
 * accepted on `POST /v1/documents/:id/index-failure`. The
 * `index_text_too_large` code is special: when paired with a row in
 * `extraction_status='pending'`, the route atomically advances
 * extraction to `'complete'` (text-in-hand implies extraction
 * succeeded) AND marks semantic_index `'failed'` so the durable row
 * reflects the upload pipeline's actual sequence.
 */
const IndexErrorCodeSchema = z.enum([
  'index_text_too_large',
  'extraction_empty',
  'unknown',
]).openapi({
  type: 'string',
  enum: ['index_text_too_large', 'extraction_empty', 'unknown'],
  description:
    'Bounded semantic-index-layer failure code. `index_text_too_large` ' +
    'is the upload-pipeline shortcut for the case where extracted text ' +
    'exceeded the index byte cap before reaching `POST /:id/index`.',
});

export type IndexErrorCode = z.infer<typeof IndexErrorCodeSchema>;

/**
 * failure-transition - request body for the constrained index-failure
 * transition. Service ownership rules match
 * `ExtractionFailureBodySchema`: the message is sanitised + truncated
 * server-side; status fields cannot be smuggled in.
 */
export const IndexFailureBodySchema = z.object({
  user_id: requiredStringBody('user_id'),
  error_code: IndexErrorCodeSchema,
  error_message: z.string(),
}).strict().transform((b) => ({
  userId: b.user_id,
  errorCode: b.error_code,
  errorMessage: b.error_message,
})).openapi({
  description:
    'Constrained transition body for the index-failure route. ' +
    'Permitted transitions: ' +
    '(a) `extraction_status=\"complete\"` + ' +
    '`semantic_index_status=\"pending\"` -> writes ' +
    '`semantic_index_status=\"failed\"`; ' +
    '(b) `extraction_status=\"pending\"` + ' +
    '`semantic_index_status=\"pending\"` AND ' +
    '`error_code=\"index_text_too_large\"` -> atomically writes ' +
    '`extraction_status=\"complete\"` + ' +
    '`semantic_index_status=\"failed\"`; ' +
    '(c) idempotent retry on already-failed rows. Any other state ' +
    'returns 409.',
});

export type IndexFailureBody = z.infer<typeof IndexFailureBodySchema>;

// ---------------------------------------------------------------------------
// PUT /v1/documents/:id/raw — raw-content managed-blob upload
// ---------------------------------------------------------------------------

/**
 * Query schema for the raw-upload route. The body is the file bytes
 * themselves (Content-Type: application/octet-stream); identifying
 * fields ride on the query string so we don't have to multipart-parse.
 */
export const UploadRawDocumentQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    content_type: z.string().optional(),
  })
  .transform((q) => ({
    userId: q.user_id,
    contentType: typeof q.content_type === 'string' && q.content_type.length > 0 ? q.content_type : undefined,
  }));

export type UploadRawDocumentQuery = z.infer<typeof UploadRawDocumentQuerySchema>;

/**
 * Exported for the cursor-list query-schema module
 * (`document-list-schemas.ts`) so the cursor-paginated routes share
 * the same parse-and-clamp semantics for `limit`. Returns
 * `defaultVal` for missing / non-numeric input; clamps to
 * `[min, max]` otherwise.
 */
export function clampInt(raw: string | undefined, defaultVal: number, min: number, max: number): number {
  const parsed = raw === undefined ? defaultVal : parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultVal;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/** Shape of the validated wire body before .transform(). */
interface RegisterDocumentWire {
  user_id: string;
  source_site: string;
  provider: string;
  external_id: string;
  account_id?: string | null;
  external_uri?: string | null;
  display_name?: string | null;
  mime_type?: string | null;
  size_bytes?: number;
  content_hash?: string | null;
  provider_version?: string | null;
  source_modified_at?: Date;
  storage_mode: 'pointer_only';
  retention_policy?: Record<string, unknown>;
  consent_policy?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  extraction_status?: 'pending' | 'not_required' | 'unsupported';
  semantic_index_status?: 'pending' | 'not_required';
}

function metadataWithinSizeCap(b: RegisterDocumentWire): boolean {
  if (!b.metadata) return true;
  return Buffer.byteLength(JSON.stringify(b.metadata), 'utf8') <= MAX_METADATA_SERIALIZED_BYTES;
}

/** Required identifying fields — always present on a validated body. */
function toRegisterDocumentIdentity(b: RegisterDocumentWire) {
  return {
    userId: b.user_id,
    sourceSite: b.source_site,
    provider: b.provider,
    externalId: b.external_id,
    accountId: b.account_id ?? null,
  };
}

/** Optional source/upstream metadata. */
function toRegisterDocumentSourceMeta(b: RegisterDocumentWire) {
  return {
    externalUri: b.external_uri ?? null,
    displayName: b.display_name ?? null,
    mimeType: b.mime_type ?? null,
    sizeBytes: b.size_bytes ?? null,
    contentHash: b.content_hash ?? null,
    providerVersion: b.provider_version ?? null,
    sourceModifiedAt: b.source_modified_at ?? null,
  };
}

/** Storage + policy + metadata bag. */
function toRegisterDocumentPolicy(b: RegisterDocumentWire) {
  return {
    storageMode: b.storage_mode,
    retentionPolicy: b.retention_policy ?? {},
    consentPolicy: b.consent_policy ?? {},
    metadata: b.metadata ?? {},
  };
}

/**
 * status-layer — restricted-initial-state status fields. Defaults match
 * the column defaults (`'not_required'`); callers opt into the
 * document pipeline by passing `'pending'`.
 */
function toRegisterDocumentLayerStatus(b: RegisterDocumentWire) {
  return {
    extractionStatus: b.extraction_status,
    semanticIndexStatus: b.semantic_index_status,
  };
}

function toRegisterDocumentInternal(b: RegisterDocumentWire) {
  return {
    ...toRegisterDocumentIdentity(b),
    ...toRegisterDocumentSourceMeta(b),
    ...toRegisterDocumentPolicy(b),
    ...toRegisterDocumentLayerStatus(b),
  };
}
