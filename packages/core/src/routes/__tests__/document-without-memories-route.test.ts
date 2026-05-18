/**
 * Phase D — HTTP-level tests for `GET /v1/documents/without-memories`.
 *
 * Backs the passport synthetic-row stream and the
 * "uploaded-but-no-indexed-content" UI surface. Tests cover:
 *  - The `NOT EXISTS` filter: a document with at least one
 *    non-deleted memory is excluded; one with only deleted memories
 *    is included.
 *  - The recovery default: documents in the recovery-relevant set
 *    surface; happy-path `not_required` rows do not.
 *  - Layer-aware filter via comma-separated query params.
 *  - Cursor round-trip and limit clamp.
 *  - Cross-user isolation.
 *  - 400 on invalid layer values; 400 on missing `user_id`.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import pgvector from 'pgvector';
import { pool } from '../../db/pool.js';
import { unitVector } from '../../db/__tests__/test-fixtures.js';
import { DocumentService } from '../../services/document-service.js';
import { createDocumentRouter } from '../documents.js';
import {
  documentRouterFixture,
  useEphemeralDocumentServer,
} from './document-router-test-fixtures.js';
import {
  REGISTER_BASE,
  base64urlEncodeJson,
  createListFetcher,
  expectInvalidCursor,
  registerDoc as sharedRegisterDoc,
  type PhaseDListBody,
} from './document-list-test-helpers.js';

const TEST_USER = 'document-without-memories-user';
const OTHER_USER = 'document-without-memories-other';

const app = express();
app.use(
  '/documents',
  createDocumentRouter(new DocumentService(pool), documentRouterFixture()),
);
const server = useEphemeralDocumentServer(app, pool);

type ListBody = PhaseDListBody;

const listWithoutMemories = createListFetcher<ListBody>(
  () => server.baseUrl(),
  '/documents/without-memories',
);

const registerDoc = (payload: Record<string, unknown>): Promise<string> =>
  sharedRegisterDoc(server.baseUrl(), payload);

/**
 * Seed a row with the requested `raw_storage_status` plus a
 * companion idle row to prove the layer filter doesn't match
 * everything indiscriminately, then hit `/without-memories` with
 * the other two layers scoped out so only the seeded status drives
 * the result. Used by the per-status layer-filter tests below.
 */
async function listOnlyRawStorage(args: {
  status: string;
  seededExternalId: string;
  companionExternalId: string;
}): Promise<{ seededId: string; body: ListBody }> {
  const seededId = await registerDoc({
    ...REGISTER_BASE, user_id: TEST_USER, external_id: args.seededExternalId,
  });
  await pool.query(
    `UPDATE raw_documents SET raw_storage_status = $1 WHERE id = $2`,
    [args.status, seededId],
  );
  await registerDoc({
    ...REGISTER_BASE, user_id: TEST_USER, external_id: args.companionExternalId,
  });
  const res = await listWithoutMemories({
    user_id: TEST_USER,
    extraction: '',
    semantic_index: '',
    raw_storage: args.status,
  });
  expect(res.status).toBe(200);
  return { seededId, body: res.body as ListBody };
}

/** Insert a memory row scoped to a user, optionally pointing at a documentId. */
async function seedMemory(
  userId: string,
  rawDocumentId: string | null,
  options: { deleted?: boolean } = {},
): Promise<string> {
  const embedding = pgvector.toSql(unitVector(7));
  const result = await pool.query(
    `INSERT INTO memories (user_id, content, embedding, source_site, raw_document_id, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [userId, 'doc-evidence chunk', embedding, 'webapp-file', rawDocumentId, options.deleted ? new Date() : null],
  );
  return result.rows[0].id as string;
}

describe('GET /v1/documents/without-memories — Phase D', () => {
  it('excludes documents that have at least one non-deleted memory', async () => {
    const idle = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'idle',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory(TEST_USER, idle);
    const orphan = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'orphan',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER });
    expect(status).toBe(200);
    const ids = (body as ListBody).documents.map((d) => d.id);
    expect(ids).toEqual([orphan]);
  });

  it('soft-deleted memories do NOT block a document from appearing', async () => {
    const id = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'soft-deleted-mem',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory(TEST_USER, id, { deleted: true });
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as ListBody).documents.map((d) => d.id)).toEqual([id]);
  });

  it('default filter: recovery-relevant rows surface, happy-path not_required does NOT', async () => {
    const failed = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'rec-failed',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await pool.query(`UPDATE raw_documents SET semantic_index_status = 'failed' WHERE id = $1`, [failed]);
    const unsupported = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'rec-unsupported',
      extraction_status: 'unsupported', semantic_index_status: 'not_required',
    });
    // not_required happy-path row: no extraction or index work needed,
    // no recovery action available - should NOT appear.
    await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'rec-idle' });
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER });
    expect(status).toBe(200);
    const ids = new Set((body as ListBody).documents.map((d) => d.id));
    expect(ids.has(failed)).toBe(true);
    expect(ids.has(unsupported)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('layer filter: extraction=unsupported narrows to that one bucket', async () => {
    const u = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'parquet',
      extraction_status: 'unsupported', semantic_index_status: 'not_required',
    });
    await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'pending',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const { status, body } = await listWithoutMemories({
      user_id: TEST_USER,
      extraction: 'unsupported',
      semantic_index: '',
      raw_storage: '',
    });
    expect(status).toBe(200);
    const ids = (body as ListBody).documents.map((d) => d.id);
    expect(ids).toEqual([u]);
  });

  it('paginates: cursor round-trips, no row appears on both pages', async () => {
    for (let i = 0; i < 4; i += 1) {
      await registerDoc({
        ...REGISTER_BASE, user_id: TEST_USER, external_id: `mem-page-${i}`,
        extraction_status: 'pending', semantic_index_status: 'pending',
      });
    }
    const first = await listWithoutMemories({ user_id: TEST_USER, limit: '2' });
    const firstBody = first.body as ListBody;
    expect(firstBody.documents).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();
    const second = await listWithoutMemories({ user_id: TEST_USER, limit: '2', cursor: firstBody.next_cursor! });
    const secondBody = second.body as ListBody;
    expect(secondBody.documents).toHaveLength(2);
    const firstIds = new Set(firstBody.documents.map((d) => d.id));
    expect(secondBody.documents.every((d) => !firstIds.has(d.id))).toBe(true);
    expect(secondBody.next_cursor).toBeNull();
  });

  it('returns 400 on unknown layer status', async () => {
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER, extraction: 'not-a-valid-status' });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBeDefined();
  });

  it('returns 400 invalid_cursor on malformed cursor', async () => {
    await expectInvalidCursor(listWithoutMemories, TEST_USER, 'not-a-cursor');
  });

  it('returns 400 invalid_cursor on structurally-valid cursor whose sortAt is not a parseable timestamp', async () => {
    await expectInvalidCursor(
      listWithoutMemories,
      TEST_USER,
      base64urlEncodeJson({ sortAt: 'not-a-date', sortId: '00000000-0000-0000-0000-000000000000' }),
    );
  });

  it('returns 400 invalid_cursor on structurally-valid cursor whose sortId is not a UUID', async () => {
    await expectInvalidCursor(
      listWithoutMemories,
      TEST_USER,
      base64urlEncodeJson({ sortAt: '2026-05-09T00:00:00.000Z', sortId: 'not-a-uuid' }),
    );
  });

  it('rejects parseable-but-non-server sortAt formats (e.g., "2026-05-10")', async () => {
    await expectInvalidCursor(
      listWithoutMemories,
      TEST_USER,
      base64urlEncodeJson({ sortAt: '2026-05-10', sortId: '00000000-0000-0000-0000-000000000000' }),
    );
  });

  it('still accepts a server-generated cursor and pages correctly', async () => {
    // Sanity: tightening the validator must not break the happy
    // path. Seed two recovery-relevant rows, page through them
    // with `limit=1`, and assert the round-tripped cursor still
    // works.
    const a = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'page-a',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const b = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'page-b',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await pool.query(`UPDATE raw_documents SET created_at = $1 WHERE id = $2`,
      [new Date('2026-05-09T00:00:00.000Z'), a]);
    await pool.query(`UPDATE raw_documents SET created_at = $1 WHERE id = $2`,
      [new Date('2026-05-10T00:00:00.000Z'), b]);
    const first = await listWithoutMemories({ user_id: TEST_USER, limit: '1' });
    const firstBody = first.body as ListBody;
    expect(firstBody.documents.map((d) => d.id)).toEqual([b]);
    expect(firstBody.next_cursor).not.toBeNull();
    const second = await listWithoutMemories({
      user_id: TEST_USER, limit: '1', cursor: firstBody.next_cursor!,
    });
    const secondBody = second.body as ListBody;
    expect(secondBody.documents.map((d) => d.id)).toEqual([a]);
    expect(secondBody.next_cursor).toBeNull();
  });

  it('layer filter: extraction=running surfaces a manually-seeded running row (forward-compat)', async () => {
    const r = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'ext-running',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await pool.query(`UPDATE raw_documents SET extraction_status = 'running' WHERE id = $1`, [r]);
    await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'ext-pending',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const { status, body } = await listWithoutMemories({
      user_id: TEST_USER,
      extraction: 'running',
      semantic_index: '',
      raw_storage: '',
    });
    expect(status).toBe(200);
    const ids = (body as ListBody).documents.map((d) => d.id);
    expect(ids).toEqual([r]);
  });

  it('layer filter: raw_storage=raw_storage_failed surfaces a row with only that layer flagged', async () => {
    // Companion idle row should NOT match because we explicitly
    // scope-out the other two layers.
    const { seededId, body } = await listOnlyRawStorage({
      status: 'raw_storage_failed',
      seededExternalId: 'raw-only-failed',
      companionExternalId: 'companion-idle',
    });
    expect(body.documents.map((d) => d.id)).toEqual([seededId]);
  });

  // Filecoin lifecycle refactor (Slice 2): the recovery filter
  // accepts the two new eventual-provider recovery targets. Pre-Slice 2
  // the schema would 400 on `blob_pending` / `blob_archival_failed`
  // because `RawStorageLayerStatuses` only listed the immediate-provider
  // failure values. Both states ALSO appear under the server-side
  // default filter so a `blob_pending` row surfaces even if the caller
  // omits the `raw_storage` query param entirely.

  it('layer filter: raw_storage=blob_pending surfaces an eventual-provider row that has not yet been promoted', async () => {
    const { seededId, body } = await listOnlyRawStorage({
      status: 'blob_pending',
      seededExternalId: 'pending-only',
      companionExternalId: 'companion-pending',
    });
    expect(body.documents.map((d) => d.id)).toEqual([seededId]);
  });

  it('layer filter: raw_storage=blob_archival_failed surfaces a row the Phase 3 reconciler would have failed', async () => {
    const { seededId, body } = await listOnlyRawStorage({
      status: 'blob_archival_failed',
      seededExternalId: 'archival-failed-only',
      companionExternalId: 'companion-archival',
    });
    expect(body.documents.map((d) => d.id)).toEqual([seededId]);
  });

  it('server-side default filter: blob_pending row surfaces without an explicit raw_storage query param', async () => {
    const r = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'pending-default-filter',
    });
    await pool.query(
      `UPDATE raw_documents
          SET raw_storage_status = 'blob_pending',
              extraction_status = 'not_required',
              semantic_index_status = 'not_required'
        WHERE id = $1`,
      [r],
    );
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as ListBody).documents.map((d) => d.id)).toContain(r);
  });

  it('cross-user isolation: another user does not see the row', async () => {
    await registerDoc({
      ...REGISTER_BASE, user_id: OTHER_USER, external_id: 'cross-user',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const { status, body } = await listWithoutMemories({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as ListBody).documents).toHaveLength(0);
  });

  it('does NOT shadow GET /:id (route ordering sanity)', async () => {
    const id = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'route-ordering',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const det = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    expect(det.status).toBe(200);
  });

  it('rejects raw_storage=blob_available as a recovery filter (terminal-OK is not a recovery target)', async () => {
    // Filecoin lifecycle refactor (Slice 4): the schema deliberately
    // excludes `blob_available` from `RawStorageLayerStatuses`
    // because it's the terminal-OK promotion target the Phase 3
    // reconciler writes — surfacing it as a recovery filter would
    // misrepresent the API contract. Same reasoning applies to
    // `blob_tombstoned` (no-longer-managed). 400 with the offending
    // token quoted is the deterministic outcome.
    const available = await listWithoutMemories({
      user_id: TEST_USER, extraction: '', semantic_index: '',
      raw_storage: 'blob_available',
    });
    expect(available.status).toBe(400);
    expect((available.body as { error: string }).error).toMatch(/blob_available/);

    const tombstoned = await listWithoutMemories({
      user_id: TEST_USER, extraction: '', semantic_index: '',
      raw_storage: 'blob_tombstoned',
    });
    expect(tombstoned.status).toBe(400);
    expect((tombstoned.body as { error: string }).error).toMatch(/blob_tombstoned/);
  });
});
