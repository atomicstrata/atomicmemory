/**
 * @file Phase D — focused query schemas for the cursor-paginated
 *       document list / recovery surfaces.
 *
 * Split out from `schemas/documents.ts` to keep that file under the
 * 400 non-comment LOC workspace rule. Shape of every cursor-based
 * Phase D query schema lives here:
 *   - `DocumentListRootQuerySchema` — `GET /v1/documents` (status-bucket
 *      filter)
 *   - `ListDocumentsWithoutMemoriesQuerySchema` —
 *      `GET /v1/documents/without-memories` (layer-aware recovery filter)
 *
 * Phase D Slice 3 will add `PassportFeedQuerySchema` here.
 *
 * Reuses the small private helpers `RequiredQueryString` and
 * `clampInt` exported from `schemas/documents.ts` so the cursor +
 * limit + user_id wire contract stays consistent across all the
 * `/v1/documents*` query schemas.
 */

import { z } from './zod-setup.js';
import { RequiredQueryString, clampInt } from './documents.js';

/**
 * Phase D shared cursor + limit defaults used by all the Phase D
 * list schemas. Module-local; the schemas below are the documented
 * surface, not the constants themselves. Slice 3 (passport-feed)
 * will reuse them when its query schema lands here.
 */
const PHASE_D_DEFAULT_LIMIT = 50;
const PHASE_D_MAX_LIMIT = 100;

/**
 * Phase D limit + cursor projection used by every Phase D query
 * schema's `.transform()`. Centralising the clamp + empty-cursor
 * coercion here keeps the wire contract identical across the three
 * Phase D query schemas and stops fallow flagging the projection as
 * duplicated. Both helpers operate on the raw query-string value, so
 * the schemas remain a literal description of the wire shape.
 */
function resolvePhaseDLimit(raw: string | undefined): number {
  return clampInt(raw, PHASE_D_DEFAULT_LIMIT, 1, PHASE_D_MAX_LIMIT);
}

function resolvePhaseDCursor(raw: string | undefined): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// GET /v1/documents — cursor-paginated, status-bucket filtered
// ---------------------------------------------------------------------------

/**
 * Phase D — coarse status-bucket filter for the standalone document
 * list. Distinct from the layer-aware filter the
 * `/without-memories` endpoint uses; this enum drives the user-
 * facing "show me my failed/pending/unsupported documents" surface
 * that doesn't need finer per-layer breakdowns.
 */
const DocumentListStatusFilterSchema = z.enum(['failed', 'unsupported', 'pending', 'all']);

export type DocumentListStatusFilter = z.infer<typeof DocumentListStatusFilterSchema>;

/**
 * Phase D — `GET /v1/documents` query schema. Cursor is opaque
 * (base64-url-encoded JSON `{ sortAt, sortId }`); the route layer
 * decodes it via `decodeListCursor` (which validates `sortAt` is a
 * parseable ISO timestamp and `sortId` is a UUID, returning null on
 * malformed inputs so the route can map to 400 invalid_cursor
 * instead of letting an SQL cast throw 500).
 */
export const DocumentListRootQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    limit: z.string().optional(),
    cursor: z.string().optional(),
    status: DocumentListStatusFilterSchema.optional(),
  })
  .transform((q) => ({
    userId: q.user_id,
    limit: resolvePhaseDLimit(q.limit),
    cursor: resolvePhaseDCursor(q.cursor),
    statusFilter: q.status ?? ('all' as const),
  }));

export type DocumentListRootQuery = z.infer<typeof DocumentListRootQuerySchema>;

// ---------------------------------------------------------------------------
// GET /v1/documents/without-memories — layer-aware recovery filter
// ---------------------------------------------------------------------------

const ExtractionLayerStatuses = ['pending', 'running', 'failed', 'unsupported'] as const;
const SemanticIndexLayerStatuses = ['pending', 'running', 'failed', 'stale'] as const;
// Filecoin lifecycle refactor (Slice 2): the recovery filter accepts
// `blob_pending` (eventual provider still propagating) and
// `blob_archival_failed` (Phase 3 reconciler's permanent-failure
// terminal) so a `/without-memories` consumer can pull rows stuck in
// either state. `blob_available` and `blob_tombstoned` are
// terminal-OK / no-longer-managed states — they are NOT recovery
// targets and stay omitted from this filter on purpose.
const RawStorageLayerStatuses = [
  'raw_storage_failed',
  'pointer_recorded',
  'blob_pending',
  'blob_archival_failed',
] as const;

type ExtractionLayerStatus = (typeof ExtractionLayerStatuses)[number];
type SemanticIndexLayerStatus = (typeof SemanticIndexLayerStatuses)[number];
type RawStorageLayerStatus = (typeof RawStorageLayerStatuses)[number];

/**
 * Phase D — comma-separated layer status param.
 *   - omitted (no key in the query string)         → `undefined`
 *     (repository applies that layer's recovery default)
 *   - empty (e.g. `extraction=` or `extraction=,,`)  → `[]`
 *     (explicit scope-out: layer matches nothing)
 *   - unknown value (e.g. `extraction=mango`)        → 400 via
 *     `ctx.addIssue` with the offending token in the message
 *   - validated tokens                                → array of the
 *     allowed enum members
 */
function commaSeparatedEnum<TLiteral extends string>(
  allowed: readonly TLiteral[],
  paramName: string,
) {
  const allowedSet = new Set<string>(allowed);
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const tokens = raw
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      for (const token of tokens) {
        if (!allowedSet.has(token)) {
          ctx.addIssue({
            code: 'custom',
            message: `${paramName}: '${token}' is not one of [${allowed.join(', ')}]`,
          });
          return undefined;
        }
      }
      return tokens as TLiteral[];
    });
}

/**
 * Phase D — `GET /v1/documents/without-memories` query schema.
 * Layer-aware filter on `extraction`, `semantic_index`, and
 * `raw_storage` query params (each comma-separated). Repository
 * applies the rev-18 recovery default when a layer is omitted.
 */
export const ListDocumentsWithoutMemoriesQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    limit: z.string().optional(),
    cursor: z.string().optional(),
    extraction: commaSeparatedEnum<ExtractionLayerStatus>(ExtractionLayerStatuses, 'extraction'),
    semantic_index: commaSeparatedEnum<SemanticIndexLayerStatus>(
      SemanticIndexLayerStatuses,
      'semantic_index',
    ),
    raw_storage: commaSeparatedEnum<RawStorageLayerStatus>(RawStorageLayerStatuses, 'raw_storage'),
  })
  .transform((q) => ({
    userId: q.user_id,
    limit: resolvePhaseDLimit(q.limit),
    cursor: resolvePhaseDCursor(q.cursor),
    statusFilter: buildRecoveryFilter(q.extraction, q.semantic_index, q.raw_storage),
  }));

export type ListDocumentsWithoutMemoriesQuery = z.infer<
  typeof ListDocumentsWithoutMemoriesQuerySchema
>;

// ---------------------------------------------------------------------------
// GET /v1/documents/passport-feed — grouped memory feed
// ---------------------------------------------------------------------------

/**
 * Phase D — `GET /v1/documents/passport-feed` query schema. Same
 * limit + cursor wire contract as the other Phase D list routes;
 * the cursor is opaque base64-url JSON `{ sortAt, sortId }` decoded
 * by `decodeListCursor` (route layer maps malformed cursors to 400
 * invalid_cursor).
 */
export const PassportFeedQuerySchema = z
  .object({
    user_id: RequiredQueryString,
    limit: z.string().optional(),
    cursor: z.string().optional(),
  })
  .transform((q) => ({
    userId: q.user_id,
    limit: resolvePhaseDLimit(q.limit),
    cursor: resolvePhaseDCursor(q.cursor),
  }));

export type PassportFeedQuery = z.infer<typeof PassportFeedQuerySchema>;

/**
 * Returns the layer-aware filter object only when at least one layer
 * was specified by the caller. Undefined output means "use the
 * repository's recovery default", which matches the SDK contract.
 */
function buildRecoveryFilter(
  extraction: ExtractionLayerStatus[] | undefined,
  semanticIndex: SemanticIndexLayerStatus[] | undefined,
  rawStorage: RawStorageLayerStatus[] | undefined,
):
  | { extraction?: ExtractionLayerStatus[]; semantic_index?: SemanticIndexLayerStatus[]; raw_storage?: RawStorageLayerStatus[] }
  | undefined {
  if (extraction === undefined && semanticIndex === undefined && rawStorage === undefined) {
    return undefined;
  }
  const filter: ReturnType<typeof buildRecoveryFilter> = {};
  if (extraction !== undefined) filter!.extraction = extraction;
  if (semanticIndex !== undefined) filter!.semantic_index = semanticIndex;
  if (rawStorage !== undefined) filter!.raw_storage = rawStorage;
  return filter;
}
