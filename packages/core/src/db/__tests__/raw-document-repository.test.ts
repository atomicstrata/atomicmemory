/**
 * Repository-level integration tests for the document pipeline (Phase 1).
 *
 * Exercises the raw-document repo functions plus the extended
 * `deleteBySource` against a real Postgres+pgvector test database.
 * Mirrors the fixture pattern in `canonical-memory-objects.test.ts`.
 *
 * Requires DATABASE_URL in .env.test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearDocumentTables, setupTestSchema } from './test-fixtures.js';
import { pool } from '../pool.js';
import {
  getRawDocumentById,
  registerRawDocument,
  softDeleteRawDocument,
  upsertRawSource,
} from '../raw-document-repository.js';

const USER_A = 'doc-repo-user-a';

describe('raw-document repository (Phase 1)', () => {
  beforeAll(async () => {
    await setupTestSchema(pool);
  });

  beforeEach(async () => {
    await clearDocumentTables(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('upsertRawSource is idempotent on the namespace key', async () => {
    const first = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
      accountId: 'acct-1',
    });
    const second = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
      accountId: 'acct-1',
    });
    expect(second.id).toBe(first.id);
  });

  it('upsertRawSource collapses null account_id into a single namespace slot', async () => {
    const first = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
    });
    const second = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
      accountId: null,
    });
    expect(second.id).toBe(first.id);
  });

  it('registerRawDocument is idempotent on the active-unique index', async () => {
    const source = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
    });
    const first = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: source.id,
      externalId: 'file-1',
      providerVersion: 'v1',
    });
    const second = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: source.id,
      externalId: 'file-1',
      providerVersion: 'v1',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
  });

  it('soft-delete then re-register yields a new id (partial unique index excludes deleted rows)', async () => {
    const source = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'webapp-file',
      provider: 'manual-upload',
    });
    const first = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: source.id,
      externalId: 'doc-1',
    });
    expect(await softDeleteRawDocument(pool, USER_A, first.document.id)).toBe(true);
    const second = await registerRawDocument(pool, {
      userId: USER_A,
      rawSourceId: source.id,
      externalId: 'doc-1',
    });
    expect(second.created).toBe(true);
    expect(second.document.id).not.toBe(first.document.id);
  });

  it('concurrent registerRawDocument calls converge on a single id (no race)', async () => {
    // Regression test for the find-then-insert race that the previous
    // implementation could trip when two requests landed in the same
    // namespace at the same time. With the atomic ON CONFLICT DO NOTHING
    // path, both promises must resolve to the same persisted row and
    // exactly one of them must report `created: true`.
    const source = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
    });
    const args = { userId: USER_A, rawSourceId: source.id, externalId: 'race-1' };
    const [a, b] = await Promise.all([
      registerRawDocument(pool, args),
      registerRawDocument(pool, args),
    ]);
    expect(a.document.id).toBe(b.document.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });

  it('upsertRawSource overwrites storage_mode + policies on conflict', async () => {
    const first = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
      storageMode: 'pointer_only',
      retentionPolicy: { days: 30 },
      consentPolicy: { allow_export: false },
    });
    const second = await upsertRawSource(pool, {
      userId: USER_A,
      sourceSite: 'drive',
      provider: 'google-drive',
      storageMode: 'pointer_only',
      retentionPolicy: { days: 7 },
      consentPolicy: { allow_export: true },
    });
    expect(second.id).toBe(first.id);
    expect(second.retentionPolicy).toEqual({ days: 7 });
    expect(second.consentPolicy).toEqual({ allow_export: true });
  });

  // The pre-Phase-5 single-shot `updateRawDocumentBlobStorageWithClient`
  // tests landed here. Phase 5 split the promotion into α/β/β2/γ
  // helpers; the equivalent end-to-end coverage now lives in
  // `services/__tests__/document-upload.test.ts` (plaintext hash
  // invariant + nested metadata shape + provider-aware status
  // mapping) and `services/__tests__/upload-decision.test.ts`
  // (classifyIdempotent + deriveFinalRawStorageStatus tables).

  it('rawStorageMetadata defaults to {} on a freshly-registered row that has not been promoted yet', async () => {
    const src = await upsertRawSource(pool, {
      userId: USER_A, sourceSite: 'drive', provider: 'google-drive',
    });
    const reg = await registerRawDocument(pool, {
      userId: USER_A, rawSourceId: src.id, externalId: 'slice2-default',
    });
    const doc = await getRawDocumentById(pool, USER_A, reg.document.id);
    expect(doc?.rawStorageMetadata).toEqual({});
  });
});
