/**
 * End-to-end (DB + route +
 * validate-response) coverage of the passport-feed redaction +
 * widening. Distinct from
 * `document-passport-feed-route.test.ts` (cursor-list coverage of the
 * grouped query / cursor pagination / status envelope) — this file
 * specifically exercises the SQL projection (`rd.storage_provider`,
 * `rd.raw_storage_metadata`) + the
 * `formatPassportFeedGroupedRow` redaction at the wire boundary.
 *
 * Coverage:
 *   - Grouped row carries `storage_provider` + redacted
 *     `raw_storage_metadata` + per-row `delete_semantics`.
 *   - Internal sidecars planted on the row never appear in the
 *     response body (PLANTED-NONCE / PLANTED-SECRET / upload_result /
 *     internal `deals[].provider` tags).
 *   - Provider-driven `delete_semantics` dispatch through the
 *     registry (`local_fs → delete`).
 *   - Pointer-only rows still surface as standalone-memory rows
 *     without provider/metadata/delete_semantics keys.
 *   - The strict `PublicRawStorageMetadataSchema` enforced by
 *     `validateResponse` does NOT 5xx on the well-formed response
 *     (regression guard).
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import pgvector from 'pgvector';
import { pool } from '../../db/pool.js';
import { unitVector } from '../../db/__tests__/test-fixtures.js';
import { DocumentService } from '../../services/document-service.js';
import { createDocumentRouter } from '../documents.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { singleStoreRegistry } from '../../storage/store-registry.js';
import {
  documentRouterFixture,
  useEphemeralDocumentServer,
} from './document-router-test-fixtures.js';
import {
  REGISTER_BASE,
  registerDoc as sharedRegisterDoc,
} from './document-list-test-helpers.js';
import { REAL_PIECE_CID_A } from '../../storage/__tests__/filecoin-cid-fixtures.js';

const TEST_USER = 'passport-feed-redaction-user';

// A real-shape `local_fs` adapter so `getDeleteSemantics` resolves to
// `'delete'` for the planted row's storage_provider. The store
// itself isn't called on a GET — we only need its capability triple
// in the registry.
const LOCAL_FS_STORE = new LocalFsRawContentStore({ root: '/tmp/passport-feed-redaction-test' });
const REGISTRY = singleStoreRegistry(LOCAL_FS_STORE);

// The route formatter reads the registry off `DocumentService` —
// pass the registry in via the constructor option per-row provider dispatch added.
const documentService = new DocumentService(pool, {
  rawContentStore: LOCAL_FS_STORE,
  storeRegistry: REGISTRY,
});

const app = express();
app.use('/documents', createDocumentRouter(documentService, documentRouterFixture()));
const server = useEphemeralDocumentServer(app, pool);

const PLANTED_INTERNAL_METADATA = {
  codec: {
    name: 'aes_gcm',
    version: 1,
    nonce: 'PLANTED-NONCE',
    tag: 'PLANTED-TAG',
    key_id: 'v1',
    encoded_content_hash: 'PLANTED-ENCODED-HEX',
  },
  filecoin: {
    ipfs_cid: 'bafy' + 'a'.repeat(55),
    piece_cid: REAL_PIECE_CID_A,
    copies: [
      { provider_id: 'f01', status: 'active' },
      { provider_id: 'f02', status: 'pending' },
    ],
    // Legacy onramp / vendor / credential leaks that MUST NOT reach
    // the wire.
    onramp: 'PLANTED-ONRAMP',
    gateway_url: 'PLANTED-GATEWAY',
    onramp_status: 'PLANTED-ONRAMP-STATUS',
    deals: [
      { deal_id: 'd1', provider: 'PLANTED-PROVIDER-1' },
      { deal_id: 'd2', provider: 'PLANTED-PROVIDER-2' },
    ],
    internal_billing_secret: 'PLANTED-SECRET',
    wallet_address: '0xPLANTED-WALLET',
  },
  upload_result: { stored_status: 'pending' },
};

async function seedMemoryAt(rawDocumentId: string | null, content: string, when: Date): Promise<string> {
  const result = await pool.query(
    `INSERT INTO memories (user_id, content, embedding, source_site, raw_document_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      TEST_USER, content,
      pgvector.toSql(unitVector(when.getTime() % 7919)),
      'webapp-file', rawDocumentId, when,
    ],
  );
  return result.rows[0].id as string;
}

async function plantStorageMetadata(documentId: string, provider: string, meta: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE raw_documents
        SET storage_mode = 'managed_blob',
            storage_provider = $2,
            storage_uri = $3,
            raw_storage_metadata = $4::jsonb
      WHERE id = $1`,
    [documentId, provider, `${provider}://planted`, JSON.stringify(meta)],
  );
}

async function fetchPassportFeed(): Promise<{ status: number; rawText: string; parsed: unknown }> {
  const res = await fetch(`${server.baseUrl()}/documents/passport-feed?user_id=${TEST_USER}`);
  const rawText = await res.text();
  return { status: res.status, rawText, parsed: JSON.parse(rawText) };
}

describe('GET /v1/documents/passport-feed — public redaction + widening', () => {
  it('grouped row exposes storage_provider, redacted metadata, and delete_semantics; planted internals never leak', async () => {
    const docId = await sharedRegisterDoc(server.baseUrl(), {
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'redaction-1',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemoryAt(docId, 'a memory backing the document', new Date('2026-05-11T00:00:00.000Z'));
    await plantStorageMetadata(docId, 'local_fs', PLANTED_INTERNAL_METADATA);

    const { status, rawText, parsed } = await fetchPassportFeed();
    expect(status).toBe(200);

    // Strict-schema validation passed (validateResponse middleware
    // would have 500'd on any unallowed key — including planted
    // internals — before reaching this point).
    expect(rawText).not.toContain('PLANTED-NONCE');
    expect(rawText).not.toContain('PLANTED-TAG');
    expect(rawText).not.toContain('PLANTED-ENCODED-HEX');
    expect(rawText).not.toContain('PLANTED-SECRET');
    expect(rawText).not.toContain('PLANTED-PROVIDER-1');
    expect(rawText).not.toContain('PLANTED-PROVIDER-2');
    expect(rawText).not.toContain('PLANTED-ONRAMP');
    expect(rawText).not.toContain('PLANTED-GATEWAY');
    expect(rawText).not.toContain('PLANTED-WALLET');
    expect(rawText).not.toContain('upload_result');
    expect(rawText).not.toContain('stored_status');

    const body = parsed as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0]!;
    expect(row.kind).toBe('document_grouped');
    expect(row.storage_provider).toBe('local_fs');
    expect(row.delete_semantics).toBe('delete');
    expect(row.raw_storage_metadata).toEqual({
      codec: { name: 'aes_gcm', version: 1 },
      filecoin: {
        ipfs_cid: 'bafy' + 'a'.repeat(55),
        piece_cid: REAL_PIECE_CID_A,
        copy_count: 2,
        provider_ids: ['f01', 'f02'],
        copy_statuses: ['active', 'pending'],
      },
    });
  });

  it('pointer-only grouped row emits provider=null + empty metadata + delete_semantics=null', async () => {
    const docId = await sharedRegisterDoc(server.baseUrl(), {
      ...REGISTER_BASE, user_id: TEST_USER, external_id: 'redaction-pointer',
      extraction_status: 'pending', semantic_index_status: 'pending',
    });
    await seedMemoryAt(docId, 'pointer-only memory', new Date('2026-05-11T01:00:00.000Z'));
    // Do NOT plant managed-blob metadata — the row stays pointer_only.

    const { status, parsed } = await fetchPassportFeed();
    expect(status).toBe(200);
    const body = parsed as { rows: Array<Record<string, unknown>> };
    const row = body.rows.find((r) => r.kind === 'document_grouped');
    expect(row).toBeDefined();
    expect(row!.storage_provider).toBeNull();
    expect(row!.raw_storage_metadata).toEqual({});
    expect(row!.delete_semantics).toBeNull();
  });

  it('standalone-memory rows are unaffected by public widening (no provider/metadata/delete_semantics keys)', async () => {
    await seedMemoryAt(null, 'standalone memory', new Date('2026-05-11T02:00:00.000Z'));

    const { status, parsed } = await fetchPassportFeed();
    expect(status).toBe(200);
    const body = parsed as { rows: Array<Record<string, unknown>> };
    const standalone = body.rows.find((r) => r.kind === 'standalone_memory');
    expect(standalone).toBeDefined();
    expect(standalone).not.toHaveProperty('storage_provider');
    expect(standalone).not.toHaveProperty('raw_storage_metadata');
    expect(standalone).not.toHaveProperty('delete_semantics');
  });
});
