/**
 * Phase D Slice 3 — HTTP-level tests for `GET /v1/documents/passport-feed`.
 *
 * Validates the data-layer grouped query: one row per
 * documentId-with-memories (with chunk_count + Phase B status
 * envelope) plus 1:1 standalone-memory rows, ordered by
 * `(sort_at DESC, sort_id DESC)` with cursor pagination.
 *
 * Coverage:
 *  - grouped row with many chunks → single row, chunk_count, latest
 *    representative
 *  - interleaved chunks from two docs group correctly + sort by
 *    latest chunk
 *  - standalone + grouped mixed in correct global order
 *  - cursor pagination: no duplicates, no skips, walks via
 *    `(sort_at, sort_id)`
 *  - deleted memories ignored; deleted/cross-user documents excluded
 *  - status envelope + last_error returned on document_grouped rows
 *  - response does NOT expose embedding / deleted_at / internal cols
 *  - malformed structured cursor → 400 invalid_cursor
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
  registerDoc as sharedRegisterDoc,
} from './document-list-test-helpers.js';

const TEST_USER = 'passport-feed-test-user';
const OTHER_USER = 'passport-feed-test-other';

const app = express();
app.use('/documents', createDocumentRouter(new DocumentService(pool), documentRouterFixture()));
const server = useEphemeralDocumentServer(app, pool);

interface PassportFeedBody {
  rows: Array<
    | {
        kind: 'document_grouped';
        document_id: string;
        sort_at: string;
        sort_id: string;
        representative: { id: string; content: string; created_at: string; source_site: string | null };
        chunk_count: number;
        raw_storage_status: string;
        extraction_status: string;
        semantic_index_status: string;
        last_error: { layer: string; code: string; message: string; occurred_at: string } | null;
        display_name: string | null;
        mime_type: string | null;
      }
    | {
        kind: 'standalone_memory';
        sort_at: string;
        sort_id: string;
        memory: { id: string; content: string; created_at: string; source_site: string | null };
      }
  >;
  next_cursor: string | null;
}

async function passportFeed(query: Record<string, string>): Promise<{ status: number; body: PassportFeedBody | { error: string } }> {
  const params = new URLSearchParams(query);
  const res = await fetch(`${server.baseUrl()}/documents/passport-feed?${params}`);
  return { status: res.status, body: (await res.json()) as PassportFeedBody | { error: string } };
}

const registerDoc = (payload: Record<string, unknown>): Promise<string> =>
  sharedRegisterDoc(server.baseUrl(), payload);

/**
 * Insert a memory row at a deterministic created_at. The vector is
 * unitVector(seed) so each call's row has a real (non-zero) embedding
 * and the dimension matches the runtime `EMBEDDING_DIMENSIONS`.
 */
async function seedMemory(opts: {
  userId: string;
  rawDocumentId: string | null;
  content: string;
  createdAt: Date;
  deleted?: boolean;
}): Promise<string> {
  const result = await pool.query(
    `INSERT INTO memories (user_id, content, embedding, source_site, raw_document_id, created_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      opts.userId,
      opts.content,
      pgvector.toSql(unitVector(opts.createdAt.getTime() % 7919)),
      'webapp-file',
      opts.rawDocumentId,
      opts.createdAt,
      opts.deleted ? new Date() : null,
    ],
  );
  return result.rows[0].id as string;
}

async function setLastError(
  documentId: string,
  layer: 'extraction' | 'semantic_index' | 'raw_storage',
  code: string,
): Promise<void> {
  await pool.query(
    `UPDATE raw_documents SET semantic_index_status = $2, last_error = $3 WHERE id = $1`,
    [
      documentId,
      'failed',
      JSON.stringify({ layer, code, message: 'fixture-injected', occurred_at: '2026-05-09T00:00:00.000Z' }),
    ],
  );
}

describe('GET /v1/documents/passport-feed — Phase D Slice 3', () => {
  it('grouped document with N chunks appears once with chunk_count and latest representative', async () => {
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'multi-chunk',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const olderMem = await seedMemory({
      userId: TEST_USER, rawDocumentId: docId, content: 'older chunk',
      createdAt: new Date('2026-05-09T00:00:00.000Z'),
    });
    const latestMem = await seedMemory({
      userId: TEST_USER, rawDocumentId: docId, content: 'latest chunk',
      createdAt: new Date('2026-05-09T01:00:00.000Z'),
    });
    const middleMem = await seedMemory({
      userId: TEST_USER, rawDocumentId: docId, content: 'middle chunk',
      createdAt: new Date('2026-05-09T00:30:00.000Z'),
    });
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    const feed = body as PassportFeedBody;
    expect(feed.rows).toHaveLength(1);
    const row = feed.rows[0]!;
    expect(row.kind).toBe('document_grouped');
    if (row.kind !== 'document_grouped') throw new Error('unreachable');
    expect(row.document_id).toBe(docId);
    expect(row.chunk_count).toBe(3);
    expect(row.representative.id).toBe(latestMem);
    expect(row.representative.content).toBe('latest chunk');
    // sort_at is the MAX(created_at) of the group.
    expect(row.sort_at).toBe('2026-05-09T01:00:00.000Z');
    expect(row.sort_id).toBe(latestMem);
    // Sanity: the older / middle memories are not separately
    // surfaced.
    expect(feed.rows.length).toBe(1);
    expect(olderMem).not.toBe(middleMem);
  });

  it('interleaved chunks from two docs group correctly and sort by latest chunk', async () => {
    const docA = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'doc-a',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    const docB = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'doc-b',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    // Interleaved: docA@t1, docB@t2, docA@t3, docB@t4. Latest of A
    // is t3, latest of B is t4. Sort puts docB first.
    await seedMemory({ userId: TEST_USER, rawDocumentId: docA, content: 'A1', createdAt: new Date('2026-05-09T00:01:00.000Z') });
    await seedMemory({ userId: TEST_USER, rawDocumentId: docB, content: 'B1', createdAt: new Date('2026-05-09T00:02:00.000Z') });
    const a3 = await seedMemory({ userId: TEST_USER, rawDocumentId: docA, content: 'A2', createdAt: new Date('2026-05-09T00:03:00.000Z') });
    const b4 = await seedMemory({ userId: TEST_USER, rawDocumentId: docB, content: 'B2', createdAt: new Date('2026-05-09T00:04:00.000Z') });
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    const feed = body as PassportFeedBody;
    expect(feed.rows.map((r) => r.kind)).toEqual(['document_grouped', 'document_grouped']);
    expect((feed.rows[0] as { document_id: string }).document_id).toBe(docB);
    expect((feed.rows[0] as { representative: { id: string } }).representative.id).toBe(b4);
    expect((feed.rows[0] as { chunk_count: number }).chunk_count).toBe(2);
    expect((feed.rows[1] as { document_id: string }).document_id).toBe(docA);
    expect((feed.rows[1] as { representative: { id: string } }).representative.id).toBe(a3);
    expect((feed.rows[1] as { chunk_count: number }).chunk_count).toBe(2);
  });

  it('standalone + grouped mix in correct global order by sort_at DESC', async () => {
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'mixed-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: TEST_USER, rawDocumentId: docId, content: 'doc chunk', createdAt: new Date('2026-05-09T01:00:00.000Z') });
    const standaloneNew = await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'sa new', createdAt: new Date('2026-05-09T02:00:00.000Z') });
    const standaloneOld = await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'sa old', createdAt: new Date('2026-05-09T00:30:00.000Z') });
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    const feed = body as PassportFeedBody;
    expect(feed.rows).toHaveLength(3);
    expect(feed.rows[0]!.kind).toBe('standalone_memory');
    expect((feed.rows[0]! as { memory: { id: string } }).memory.id).toBe(standaloneNew);
    expect(feed.rows[1]!.kind).toBe('document_grouped');
    expect((feed.rows[1]! as { document_id: string }).document_id).toBe(docId);
    expect(feed.rows[2]!.kind).toBe('standalone_memory');
    expect((feed.rows[2]! as { memory: { id: string } }).memory.id).toBe(standaloneOld);
  });

  it('cursor pagination: no duplicates, no skips, walks via (sort_at, sort_id)', async () => {
    // Seed 3 distinct items at distinct timestamps. Page-size=1.
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'paginated-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: TEST_USER, rawDocumentId: docId, content: 'd1', createdAt: new Date('2026-05-09T00:00:00.000Z') });
    await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'sa-mid', createdAt: new Date('2026-05-09T00:30:00.000Z') });
    await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'sa-late', createdAt: new Date('2026-05-09T01:00:00.000Z') });
    const seenIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const query: Record<string, string> = { user_id: TEST_USER, limit: '1' };
      if (cursor !== undefined) query.cursor = cursor;
      const { status, body } = await passportFeed(query);
      expect(status).toBe(200);
      const feed = body as PassportFeedBody;
      if (feed.rows.length === 0) break;
      expect(feed.rows).toHaveLength(1);
      const r = feed.rows[0]!;
      const id = r.kind === 'document_grouped' ? r.document_id : r.memory.id;
      expect(seenIds.has(id)).toBe(false);
      seenIds.add(id);
      cursor = feed.next_cursor ?? undefined;
      if (cursor === undefined) break;
    }
    expect(seenIds.size).toBe(3);
  });

  it('deleted memories are ignored from grouping and standalone branches', async () => {
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'deleted-mem-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    // The only memory pointing to this doc is deleted → doc must not
    // appear (it falls into the `/without-memories` stream instead).
    await seedMemory({ userId: TEST_USER, rawDocumentId: docId, content: 'gone', createdAt: new Date('2026-05-09T00:00:00.000Z'), deleted: true });
    // A deleted standalone memory likewise must not appear.
    await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'gone-sa', createdAt: new Date('2026-05-09T00:30:00.000Z'), deleted: true });
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as PassportFeedBody).rows).toEqual([]);
  });

  it('cross-user / soft-deleted documents are excluded from grouped rows', async () => {
    const otherDoc = await registerDoc({
      ...REGISTER_BASE, user_id: OTHER_USER, external_id: 'cross-user-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: OTHER_USER, rawDocumentId: otherDoc, content: 'cross', createdAt: new Date('2026-05-09T00:00:00.000Z') });
    const tomb = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'tombed-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: TEST_USER, rawDocumentId: tomb, content: 'tomb', createdAt: new Date('2026-05-09T00:00:00.000Z') });
    await pool.query(`UPDATE raw_documents SET deleted_at = NOW() WHERE id = $1`, [tomb]);
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    expect((body as PassportFeedBody).rows).toEqual([]);
  });

  it('grouped rows carry the Phase B status envelope including last_error', async () => {
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'with-status',
      display_name: 'plan.md', mime_type: 'text/markdown',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: TEST_USER, rawDocumentId: docId, content: 'partial chunk', createdAt: new Date('2026-05-09T00:00:00.000Z') });
    await setLastError(docId, 'semantic_index', 'index_text_too_large');
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    const feed = body as PassportFeedBody;
    const row = feed.rows[0]!;
    if (row.kind !== 'document_grouped') throw new Error('expected grouped row');
    expect(row.semantic_index_status).toBe('failed');
    expect(row.last_error?.layer).toBe('semantic_index');
    expect(row.last_error?.code).toBe('index_text_too_large');
    expect(row.display_name).toBe('plan.md');
    expect(row.mime_type).toBe('text/markdown');
  });

  it('response does NOT expose embedding / deleted_at / internal columns', async () => {
    const docId = await registerDoc({
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'no-leak-doc',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemory({ userId: TEST_USER, rawDocumentId: docId, content: 'doc', createdAt: new Date('2026-05-09T00:00:00.000Z') });
    await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'standalone', createdAt: new Date('2026-05-09T01:00:00.000Z') });
    const { status, body } = await passportFeed({ user_id: TEST_USER });
    expect(status).toBe(200);
    const flat = JSON.stringify(body);
    expect(flat).not.toContain('"embedding"');
    expect(flat).not.toContain('"deleted_at"');
    expect(flat).not.toContain('"trust_score"');
    expect(flat).not.toContain('"keywords"');
    expect(flat).not.toContain('"namespace"');
    // Spot-check the public shape.
    const feed = body as PassportFeedBody;
    for (const row of feed.rows) {
      if (row.kind === 'document_grouped') {
        expect(Object.keys(row.representative).sort()).toEqual(
          ['content', 'created_at', 'id', 'source_site'].sort(),
        );
      } else {
        expect(Object.keys(row.memory).sort()).toEqual(
          ['content', 'created_at', 'id', 'source_site'].sort(),
        );
      }
    }
  });

  it('same-timestamp tie-break: rows with identical sort_at order by sort_id DESC, cursor walks the tie cleanly', async () => {
    // Two standalone memories at identical `created_at`. The
    // documented tie-break is `sort_id DESC`, so the row whose
    // UUID sorts last (lexicographically) appears first. Page-1
    // returns the larger-id row; page-2's cursor (built from
    // page-1's sort_id) must skip past it without duplication
    // and surface the smaller-id row.
    const tieAt = new Date('2026-05-09T03:00:00.000Z');
    const idA = await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'tie-a', createdAt: tieAt });
    const idB = await seedMemory({ userId: TEST_USER, rawDocumentId: null, content: 'tie-b', createdAt: tieAt });
    const expected = [idA, idB].sort().reverse();

    const first = await passportFeed({ user_id: TEST_USER, limit: '1' });
    const firstBody = first.body as PassportFeedBody;
    expect(firstBody.rows).toHaveLength(1);
    const firstRow = firstBody.rows[0]!;
    if (firstRow.kind !== 'standalone_memory') throw new Error('expected standalone');
    expect(firstRow.memory.id).toBe(expected[0]);
    expect(firstRow.sort_at).toBe(tieAt.toISOString());
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await passportFeed({
      user_id: TEST_USER, limit: '1', cursor: firstBody.next_cursor!,
    });
    const secondBody = second.body as PassportFeedBody;
    expect(secondBody.rows).toHaveLength(1);
    const secondRow = secondBody.rows[0]!;
    if (secondRow.kind !== 'standalone_memory') throw new Error('expected standalone');
    expect(secondRow.memory.id).toBe(expected[1]);
    expect(secondRow.sort_at).toBe(tieAt.toISOString());
    // No duplicates; sequence is exactly the two seeded rows.
    expect(new Set([firstRow.memory.id, secondRow.memory.id]).size).toBe(2);
    // Stream exhausts after both rows.
    expect(secondBody.next_cursor).toBeNull();
  });

  it('returns 400 invalid_cursor on malformed structured cursor', async () => {
    const cursor = base64urlEncodeJson({ sortAt: 'not-a-date', sortId: 'not-a-uuid' });
    const { status, body } = await passportFeed({ user_id: TEST_USER, cursor });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('invalid_cursor');
  });

  it('does NOT shadow GET /:id (route-ordering sanity)', async () => {
    const id = await registerDoc({ ...REGISTER_BASE, user_id: TEST_USER, external_id: 'order-check' });
    const det = await fetch(`${server.baseUrl()}/documents/${id}?user_id=${TEST_USER}`);
    expect(det.status).toBe(200);
  });
});
