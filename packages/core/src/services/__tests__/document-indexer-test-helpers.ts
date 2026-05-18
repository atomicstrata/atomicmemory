/**
 * Shared seed helpers for the document-indexer test files.
 *
 * `document-indexer.test.ts` (happy-path + cascade tests) and
 * `document-indexer-status.test.ts` (Phase B status-transition tests)
 * both register a `raw_documents` row that has opted into the
 * semantic-index pipeline (`extraction_status='pending'`,
 * `semantic_index_status='pending'`) before driving the indexer.
 *
 * Phase B's CAS guard rejects rows whose `semantic_index_status` is
 * `'not_required'` (the column default), so test fixtures MUST opt in
 * — otherwise `service.indexText` surfaces 409 `IndexInvalidStateError`
 * instead of running the happy path. Centralising the helper here keeps
 * both test files tight and avoids the fallow clone-group warning the
 * Phase B review flagged.
 */

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  clearDocumentTables,
  setupTestSchema,
} from '../../db/__tests__/test-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import type {
  RawDocumentRow,
  RegisterRawDocumentInput,
} from '../../db/raw-document-types.js';

/**
 * Wire the standard `setupTestSchema` / `clearDocumentTables` /
 * `pool.end` lifecycle for an indexer test file. Centralised so each
 * indexer suite registers the same lifecycle pattern verbatim — this
 * eliminates the small clone group fallow flags between
 * `document-indexer.test.ts` and `document-indexer-status.test.ts`.
 *
 * Call from FILE TOP LEVEL (not inside a `describe`) so the lifecycle
 * applies across every describe block in the file. Vitest runs each
 * `describe`'s tests sequentially against the same lifecycle.
 */
export function useDocumentIndexerLifecycle(pool: pg.Pool): void {
  beforeAll(async () => { await setupTestSchema(pool); });
  beforeEach(async () => { await clearDocumentTables(pool); });
  afterAll(async () => { await pool.end(); });
}

export interface SeedIndexableDocOptions {
  externalId: string;
  sourceSite?: string;
  provider?: string;
  /** Override the registration-time extraction status. Defaults to `'pending'`. */
  extractionStatus?: RegisterRawDocumentInput['extractionStatus'];
  /** Override the registration-time semantic-index status. Defaults to `'pending'`. */
  semanticIndexStatus?: RegisterRawDocumentInput['semanticIndexStatus'];
  displayName?: string | null;
  mimeType?: string | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
  externalUri?: string | null;
}

/**
 * Register a `raw_documents` row owned by `userId`, opted into the
 * semantic-index pipeline by default. Tests that want to exercise
 * non-default statuses (`'not_required'`, `'unsupported'`) can pass
 * an override.
 */
export async function seedIndexableDoc(
  pool: pg.Pool,
  userId: string,
  opts: SeedIndexableDocOptions,
): Promise<RawDocumentRow> {
  const sourceSite = opts.sourceSite ?? 'drive';
  const provider = opts.provider ?? 'google-drive';
  const src = await upsertRawSource(pool, { userId, sourceSite, provider });
  const reg = await registerRawDocument(pool, {
    userId,
    rawSourceId: src.id,
    externalId: opts.externalId,
    externalUri: opts.externalUri,
    displayName: opts.displayName,
    mimeType: opts.mimeType,
    contentHash: opts.contentHash,
    metadata: opts.metadata,
    extractionStatus: opts.extractionStatus ?? 'pending',
    semanticIndexStatus: opts.semanticIndexStatus ?? 'pending',
  });
  return reg.document;
}
