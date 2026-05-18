/**
 * @file cursor-list — focused response schemas for the cursor-paginated
 *       document list / recovery / passport-feed endpoints.
 *
 * Split out from `schemas/responses.ts` (already at 456 non-comment
 * LOC) so adding the cursor-list Slice 3 surface doesn't push the
 * shared response-schema file further over the workspace's 400 LOC
 * rule. The validate-response middleware imports these by name via
 * `routes/response-schema-map.ts`.
 *
 * Wire format is snake_case end-to-end. The discriminated union on
 * `kind` is the public shape — internal columns (embeddings, audit
 * fields, internal metadata) are deliberately absent.
 */

import { z } from './zod-setup.js';
import {
  ExtractionStatusEnumSchema,
  LastErrorEnvelopeSchema,
  RawStorageStatusEnumSchema,
  SemanticIndexStatusEnumSchema,
} from './document-status-envelope.js';
import {
  DeleteSemanticsEnumSchema,
  PublicRawStorageMetadataSchema,
} from './document-response-schemas.js';

/**
 * cursor-list — public passport-feed representative subset. Mirrors the
 * fields a UI list-row card needs (id / content / created_at /
 * source_site) without exposing embeddings, internal metadata, or
 * soft-delete flags.
 */
const PassportFeedRepresentativeSchema = z.object({
  id: z.string(),
  content: z.string(),
  created_at: z.string(),
  source_site: z.string().nullable(),
});

/**
 * cursor-list — `document_grouped` row: one per documentId-with-memories.
 * Carries the chunk_count + the latest chunk as `representative` +
 * the status-layer status envelope joined from `raw_documents`.
 */
const PassportFeedDocumentGroupedRowSchema = z.object({
  kind: z.literal('document_grouped'),
  document_id: z.string(),
  sort_at: z.string(),
  sort_id: z.string(),
  representative: PassportFeedRepresentativeSchema,
  chunk_count: z.number().int().nonnegative(),
  raw_storage_status: RawStorageStatusEnumSchema,
  extraction_status: ExtractionStatusEnumSchema,
  semantic_index_status: SemanticIndexStatusEnumSchema,
  last_error: LastErrorEnvelopeSchema,
  display_name: z.string().nullable(),
  mime_type: z.string().nullable(),
  // public wire widening (public contract): grouped rows now carry
  // `storage_provider` + the redacted `raw_storage_metadata` +
  // per-row `delete_semantics` so the webapp can render
  // provider-aware UI (CID chip, capability-driven delete copy)
  // without an extra GET. Standalone-memory rows stay status-only.
  storage_provider: z.string().nullable(),
  raw_storage_metadata: PublicRawStorageMetadataSchema,
  delete_semantics: DeleteSemanticsEnumSchema,
});

/**
 * cursor-list — `standalone_memory` row: 1:1 the underlying memory
 * (raw_document_id IS NULL). No status envelope (there is no
 * document) and no `chunk_count` on the wire — the public shape
 * exposes the memory verbatim so consumers branch on `kind`
 * instead of trying to render the two row kinds with the same
 * field set.
 */
const PassportFeedStandaloneMemoryRowSchema = z.object({
  kind: z.literal('standalone_memory'),
  sort_at: z.string(),
  sort_id: z.string(),
  memory: PassportFeedRepresentativeSchema,
});

const PassportFeedRowSchema = z
  .discriminatedUnion('kind', [
    PassportFeedDocumentGroupedRowSchema,
    PassportFeedStandaloneMemoryRowSchema,
  ])
  .openapi({ description: 'Passport-feed row (document_grouped or standalone_memory).' });

export const PassportFeedResponseSchema = z
  .object({
    rows: z.array(PassportFeedRowSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi({
    description:
      'Passport feed: grouped memory-backed document rows + ' +
      '1:1 standalone memory rows, unioned and ordered by ' +
      '(sort_at DESC, sort_id DESC). `next_cursor` is the opaque ' +
      'continuation cursor; null indicates the stream is exhausted.',
  });
