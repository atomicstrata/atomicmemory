/**
 * @file Shared Phase B status-envelope sub-schemas.
 *
 * The same enum + last_error tuple appears in
 * `RawDocumentResponseSchema` (full document row) AND in
 * `PassportFeedDocumentGroupedRowSchema` (the passport-feed grouped
 * row's per-layer status snapshot). Inlining the literals in both
 * places caused fallow's clone detector to flag a 31-line duplicate;
 * centralising them here keeps the wire contract in one place.
 */

import { z } from './zod-setup.js';

// Filecoin lifecycle refactor (Slice 2): the wire enum tracks the DB
// CHECK constraint + the `RawStorageStatus` TypeScript union — all
// three must agree. The Zod response validator (`middleware/
// validate-response.ts`) reads this schema for every document
// response, so a row in a Phase-1-reserved state (`blob_pending`)
// must be acceptable on the wire even before its dedicated UI /
// recovery flows ship. Slice 4 layers the camelCase→snake_case
// capability map on top of this schema family on the limits route.
export const RawStorageStatusEnumSchema = z.enum([
  'pointer_recorded',
  'blob_stored',
  'inline_text_stored',
  'raw_storage_failed',
  'blob_deleted',
  'blob_pending',
  'blob_available',
  'blob_archival_failed',
  'blob_tombstoned',
]);

export const ExtractionStatusEnumSchema = z.enum([
  'not_required',
  'pending',
  'running',
  'complete',
  'unsupported',
  'failed',
]);

export const SemanticIndexStatusEnumSchema = z.enum([
  'not_required',
  'pending',
  'running',
  'complete',
  'failed',
  'stale',
]);

export const LastErrorEnvelopeSchema = z
  .object({
    layer: z.enum(['raw_storage', 'extraction', 'semantic_index']),
    code: z.string(),
    message: z.string(),
    occurred_at: z.string(),
  })
  .nullable();
