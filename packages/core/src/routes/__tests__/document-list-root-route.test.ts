/**
 * Phase D — HTTP-level tests for `GET /v1/documents` (cursor-paginated
 * root list with status-bucket filter).
 *
 * Distinct from the legacy `/list` (offset/limit + source_site filter)
 * tests in `documents.test.ts`. These tests exercise:
 *  - Cursor round-trip and correct ordering across pages.
 *  - Status filter buckets (`'failed' | 'unsupported' | 'pending' | 'all'`)
 *    pivot on the Phase B per-layer columns.
 *  - Cross-user isolation.
 *  - Malformed cursor surfaces as 400 `invalid_cursor`.
 *  - Limit clamp (request 200 -> 100 ceiling).
 *
 * Requires DATABASE_URL in .env.test.
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import { pool } from '../../db/pool.js';
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
  seedLayerStatus as sharedSeedLayerStatus,
  type PhaseDListBody,
} from './document-list-test-helpers.js';

const TEST_USER = 'document-list-root-test-user';
const OTHER_USER = 'document-list-root-test-other';

const app = express();
app.use('/documents', createDocumentRouter(new DocumentService(pool), documentRouterFixture()));
const server = useEphemeralDocumentServer(app, pool);

type ListBody = PhaseDListBody & {
  documents: { id: string; user_id: string; extraction_status: string; semantic_index_status: string }[];
};

const listRoot = createListFetcher<ListBody>(() => server.baseUrl(), '/documents');

const registerDoc = (payload: Record<string, unknown>): Promise<string> =>
  sharedRegisterDoc(server.baseUrl(), payload);

const seedLayerStatus = (
  documentId: string,
  fields: Parameters<typeof sharedSeedLayerStatus>[2],
): Promise<void> => sharedSeedLayerStatus(pool, documentId, fields);

/**
 * Seed exactly one row matching a `status` bucket (via direct DB
 * UPDATE to the supplied layer fields), plus a companion idle row to
 * prove the bucket filter doesn't match indiscriminately, then hit
 * `GET /v1/documents?status=...` and return the listed ids alongside
 * the seeded id. Used by the per-bucket regression tests below.
 */
async function listBucketWithOnlyRow(args: {
  seededExternalId: string;
  companionExternalId: string;
  layerFields: Parameters<typeof seedLayerStatus>[1];
  status: 'failed' | 'pending' | 'unsupported';
}): Promise<{ seededId: string; listedIds: string[] }> {
  const seededId = await registerDoc({
    ...REGISTER_BASE, user_id: TEST_USER, external_id: args.seededExternalId,
    extraction_status: 'pending', semantic_index_status: 'pending',
  });
  await seedLayerStatus(seededId, args.layerFields);
  await registerDoc({
    ...REGISTER_BASE, user_id: TEST_USER, external_id: args.companionExternalId,
  });
  const { status, body } = await listRoot({ user_id: TEST_USER, status: args.status });
  expect(status).toBe(200);
  return { seededId, listedIds: (body as ListBody).documents.map((d) => d.id) };
}

describe('GET /v1/documents — Phase D root list', () => {
  it('returns empty list with null cursor when the user has no documents', async () => {
    const { status, body } = await listRoot({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as ListBody).documents).toEqual([]);
    expect((body as ListBody).next_cursor).toBeNull();
  });

  it('lists active documents (created_at DESC, id DESC) and excludes cross-user rows', async () => {
    // Deterministically seed `created_at` so the DESC ordering
    // assertion does not lean on monotonic NOW() defaults. The
    // route is documented to sort by `(created_at DESC, id DESC)`;
    // the test now proves that contract directly: `older` has the
    // earlier timestamp, `newer` has the later one, so `newer`
    // must come first.
    const older = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'older' });
    const newer = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'newer' });
    await registerDoc({ ...REGISTER_BASE, user_id: OTHER_USER, external_id: 'cross-user' });
    await pool.query(`UPDATE raw_documents SET created_at = $1 WHERE id = $2`,
      [new Date('2026-05-09T00:00:00.000Z'), older]);
    await pool.query(`UPDATE raw_documents SET created_at = $1 WHERE id = $2`,
      [new Date('2026-05-10T00:00:00.000Z'), newer]);
    const { status, body } = await listRoot({ user_id: TEST_USER });
    expect(status).toBe(200);
    const list = body as ListBody;
    expect(list.documents.map((d) => d.id)).toEqual([newer, older]);
    expect(list.documents.every((d) => d.user_id === TEST_USER)).toBe(true);
    expect(list.next_cursor).toBeNull();
  });

  it('paginates: cursor round-trips, no row appears on both pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: `page-${i}` }));
    }
    const first = await listRoot({ user_id: TEST_USER, limit: '2' });
    const firstBody = first.body as ListBody;
    expect(firstBody.documents).toHaveLength(2);
    expect(firstBody.next_cursor).not.toBeNull();
    const second = await listRoot({ user_id: TEST_USER, limit: '2', cursor: firstBody.next_cursor! });
    const secondBody = second.body as ListBody;
    expect(secondBody.documents).toHaveLength(2);
    const firstIds = new Set(firstBody.documents.map((d) => d.id));
    expect(secondBody.documents.every((d) => !firstIds.has(d.id))).toBe(true);
    const third = await listRoot({ user_id: TEST_USER, limit: '2', cursor: secondBody.next_cursor! });
    const thirdBody = third.body as ListBody;
    expect(thirdBody.documents).toHaveLength(1);
    expect(thirdBody.next_cursor).toBeNull();
  });

  it('status=failed surfaces only rows with any failed layer', async () => {
    const a = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'fail-a' });
    await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'ok-b' });
    const c = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'fail-c' });
    await seedLayerStatus(a, { semantic_index_status: 'failed' });
    await seedLayerStatus(c, { raw_storage_status: 'raw_storage_failed' });
    const { status, body } = await listRoot({ user_id: TEST_USER, status: 'failed' });
    expect(status).toBe(200);
    const ids = new Set((body as ListBody).documents.map((d) => d.id));
    expect(ids.has(a)).toBe(true);
    expect(ids.has(c)).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('status=unsupported returns only extraction_status=unsupported rows', async () => {
    const u = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'parquet',
      extraction_status: 'unsupported', semantic_index_status: 'not_required',
    });
    await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'normal' });
    const { status, body } = await listRoot({ user_id: TEST_USER, status: 'unsupported' });
    expect(status).toBe(200);
    expect((body as ListBody).documents).toHaveLength(1);
    expect((body as ListBody).documents[0]?.id).toBe(u);
  });

  it('status=pending matches extraction OR semantic_index in pending/running', async () => {
    await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'p1',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'idle' });
    const { status, body } = await listRoot({ user_id: TEST_USER, status: 'pending' });
    expect(status).toBe(200);
    expect((body as ListBody).documents).toHaveLength(1);
    expect((body as ListBody).documents[0]?.extraction_status).toBe('pending');
  });

  it('returns 400 invalid_cursor on malformed cursor', async () => {
    await expectInvalidCursor(listRoot, TEST_USER, 'not-base64-json');
  });

  it('returns 400 invalid_cursor on structurally-valid cursor whose sortAt is not a parseable timestamp', async () => {
    // Without the sortAt validation in `decodeListCursor`, this
    // would slip past the cursor decode and hit the DB cast
    // (`$N::timestamptz`), producing a 500 from Postgres.
    await expectInvalidCursor(
      listRoot,
      TEST_USER,
      base64urlEncodeJson({ sortAt: 'not-a-date', sortId: '00000000-0000-0000-0000-000000000000' }),
    );
  });

  it('returns 400 invalid_cursor on structurally-valid cursor whose sortId is not a UUID', async () => {
    await expectInvalidCursor(
      listRoot,
      TEST_USER,
      base64urlEncodeJson({ sortAt: '2026-05-09T00:00:00.000Z', sortId: 'not-a-uuid' }),
    );
  });

  it('rejects parseable-but-non-server sortAt formats (e.g., "2026-05-10")', async () => {
    // `Date.parse('2026-05-10')` succeeds but the cursor encoder
    // never emits this shape — only `Date#toISOString()`'s
    // `YYYY-MM-DDTHH:mm:ss.sssZ`. The tightened validator must
    // reject it as 400 invalid_cursor rather than 200 (with
    // potentially incorrect SQL ordering against the loose
    // timestamp).
    await expectInvalidCursor(
      listRoot,
      TEST_USER,
      base64urlEncodeJson({ sortAt: '2026-05-10', sortId: '00000000-0000-0000-0000-000000000000' }),
    );
  });

  it('rejects parseable-but-non-server sortAt formats (e.g., "May 10 2026")', async () => {
    await expectInvalidCursor(
      listRoot,
      TEST_USER,
      base64urlEncodeJson({ sortAt: 'May 10 2026', sortId: '00000000-0000-0000-0000-000000000000' }),
    );
  });

  it('rejects sortAt whose components match the regex but represent an invalid date (e.g., "2026-13-99T00:00:00.000Z")', async () => {
    await expectInvalidCursor(
      listRoot,
      TEST_USER,
      base64urlEncodeJson({
        sortAt: '2026-13-99T00:00:00.000Z',
        sortId: '00000000-0000-0000-0000-000000000000',
      }),
    );
  });

  it('status=failed surfaces rows with raw_storage_status=raw_storage_failed only', async () => {
    const out = await listBucketWithOnlyRow({
      seededExternalId: 'raw-only-fail',
      companionExternalId: 'idle-row',
      layerFields: { raw_storage_status: 'raw_storage_failed' },
      status: 'failed',
    });
    expect(out.listedIds).toEqual([out.seededId]);
  });

  it('status=pending surfaces a row whose extraction_status is running (forward-compat)', async () => {
    // The Phase B synchronous indexer never commits 'running'; this
    // seed simulates the future async-worker PR state so the filter
    // clause stays correct.
    const out = await listBucketWithOnlyRow({
      seededExternalId: 'running-fwd-compat',
      companionExternalId: 'unrelated-idle',
      layerFields: { extraction_status: 'running' },
      status: 'pending',
    });
    expect(out.listedIds).toEqual([out.seededId]);
  });

  // Filecoin lifecycle refactor: the failed/pending buckets must be
  // aware of the eventual-provider raw-storage states or Filecoin
  // rows disappear from /v1/documents while still surfacing in
  // /without-memories — a silent contract drift.

  it('status=failed surfaces a row whose raw_storage_status=blob_archival_failed (eventual-provider terminal)', async () => {
    const out = await listBucketWithOnlyRow({
      seededExternalId: 'archival-fail-bucket',
      companionExternalId: 'idle-companion-archival',
      layerFields: { raw_storage_status: 'blob_archival_failed' },
      status: 'failed',
    });
    expect(out.listedIds).toEqual([out.seededId]);
  });

  it('status=pending surfaces a row whose raw_storage_status=blob_pending (eventual-provider in-flight)', async () => {
    const out = await listBucketWithOnlyRow({
      seededExternalId: 'blob-pending-bucket',
      companionExternalId: 'idle-companion-blob-pending',
      layerFields: {
        raw_storage_status: 'blob_pending',
        extraction_status: 'not_required',
        semantic_index_status: 'not_required',
      },
      status: 'pending',
    });
    expect(out.listedIds).toEqual([out.seededId]);
  });

  it('clamps limit above 100 to the 100 ceiling', async () => {
    for (let i = 0; i < 3; i += 1) {
      await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: `c${i}` });
    }
    // Asking for limit=200 should not 400; the schema clamps it to 100.
    const { status } = await listRoot({ user_id: TEST_USER, limit: '200' });
    expect(status).toBe(200);
  });

  it('returns 400 when user_id is missing', async () => {
    const res = await fetch(`${server.baseUrl()}/documents`);
    expect(res.status).toBe(400);
  });

  it('does NOT shadow GET /:id (legacy `/list` route still resolves)', async () => {
    // Routing sanity: `/list` is a query-only GET registered before
    // `/:id`. The new root list at `/` cannot interfere.
    const id = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'list-resolve' });
    const list = await fetch(`${server.baseUrl()}/documents/list?user_id=${TEST_USER}`);
    expect(list.status).toBe(200);
    const det = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    expect(det.status).toBe(200);
  });
});
