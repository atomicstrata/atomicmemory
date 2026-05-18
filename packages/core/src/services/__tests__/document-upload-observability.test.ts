/**
 * Phase 8.5 — integration coverage for the upload pipeline's
 * structured observability events.
 *
 * Locks the three event names + payload shapes a real upload run
 * emits:
 *   - `filecoin.upload.started` once at the top of every uploadRaw
 *     call, carrying documentId + userId.
 *   - `filecoin.upload.accepted` on the happy path, carrying the
 *     final `provider`, `statusAfter`, and a `durationMs`.
 *   - `filecoin.upload.failed` on any thrown error, carrying a
 *     sanitized `errorMessage` + a categorical `errorCode`.
 *
 * The redaction unit tests in `filecoin-observability.test.ts` lock
 * the sanitizer; this file is the end-to-end proof that the wiring
 * routes vendor errors through the sanitizer before they hit the
 * event stream.
 */

import { describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { uploadRawDocument } from '../document-upload.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
import type {
  RawContentStore,
  RawContentStoreCapabilities,
  StoredRawContent,
} from '../../storage/raw-content-store.js';
import {
  captureFilecoinEvents,
  findFilecoinEvent,
  registerEmptyDocument,
  useDocumentTestLifecycle,
} from './filecoin-event-test-helpers.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const USER = 'phase85-upload-obs';
const PAYLOAD = Buffer.from('phase 8.5 upload observability payload', 'utf8');
const CFG = { rawStoragePrefix: 'phase85', rawStorageMode: 'managed_blob' as const, storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET };

const CAP: RawContentStoreCapabilities = {
  addressing: 'content',
  retrievalConsistency: 'eventual',
  deleteSemantics: 'tombstone',
  supportsHead: true,
  supportsGet: true,
};

function makeFilecoinStore(args: {
  putStatus?: 'stored' | 'pending';
  throwOnPut?: Error;
}): RawContentStore {
  return {
    provider: 'filecoin',
    capabilities: CAP,
    async put({ key, body }): Promise<StoredRawContent> {
      if (args.throwOnPut) throw args.throwOnPut;
      return {
        storageUri: `ipfs://bafy-${key}`,
        storageProvider: 'filecoin',
        contentHash: 'unused',
        sizeBytes: body.length,
        status: args.putStatus ?? 'stored',
        providerMetadata: { filecoin: { ipfs_cid: `bafy-${key}` } },
      };
    },
    async get() { throw new Error('not used'); },
    async head() { return { exists: true, metadata: null }; },
    async delete() { return { deleted: true, semantics: 'tombstoned' }; },
  };
}

/**
 * Phase 8.5 review-fix HIGH 3 — a local_fs adapter that mirrors
 * the production immediate-provider shape (capabilities differ;
 * provider name is `'local_fs'`, NOT `'filecoin'`). Uploads through
 * this store MUST NOT emit any `[FILECOIN]` events.
 */
function makeLocalFsStore(): RawContentStore {
  return {
    provider: 'local_fs',
    capabilities: {
      addressing: 'location',
      retrievalConsistency: 'immediate',
      deleteSemantics: 'delete',
      supportsHead: true,
      supportsGet: true,
    },
    async put({ key, body }): Promise<StoredRawContent> {
      return {
        storageUri: `local-fs://${key}`,
        storageProvider: 'local_fs',
        contentHash: 'unused',
        sizeBytes: body.length,
        status: 'stored',
        providerMetadata: {},
      };
    },
    async get() { throw new Error('not used'); },
    async head() { return { exists: true, metadata: null }; },
    async delete() { return { deleted: true, semantics: 'deleted' }; },
  };
}

// `captureFilecoinEvents` + `findFilecoinEvent` +
// `registerEmptyDocument` + `useDocumentTestLifecycle` live in
// `filecoin-event-test-helpers.ts` (rev-cleanup §1 — fallow flagged
// the inline seed/capture/lifecycle patterns as clones).

const seedDoc = (id: string): Promise<string> => registerEmptyDocument(USER, id);

useDocumentTestLifecycle();

describe('upload observability — happy path', () => {
  it('emits started + accepted with durationMs and the final status', async () => {
    const id = await seedDoc('upload-obs-happy');
    const { events, restore } = captureFilecoinEvents();
    try {
      await uploadRawDocument(
        pool, makeFilecoinStore({ putStatus: 'stored' }),
        new NoopRawContentCodec(), CFG,
        { userId: USER, documentId: id, body: PAYLOAD, contentType: 'application/octet-stream' },
      );
    } finally {
      restore();
    }
    const started = findFilecoinEvent(events, 'filecoin.upload.started');
    expect(started).toBeDefined();
    expect(started!.detail.documentId).toBe(id);
    expect(started!.detail.userId).toBe(USER);

    const accepted = findFilecoinEvent(events, 'filecoin.upload.accepted');
    expect(accepted).toBeDefined();
    expect(accepted!.detail.provider).toBe('filecoin');
    expect(accepted!.detail.statusAfter).toBe('blob_available');
    expect(typeof accepted!.detail.durationMs).toBe('number');
    expect(accepted!.detail.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('emits accepted with statusAfter=blob_pending when adapter returns pending', async () => {
    const id = await seedDoc('upload-obs-pending');
    const { events, restore } = captureFilecoinEvents();
    try {
      await uploadRawDocument(
        pool, makeFilecoinStore({ putStatus: 'pending' }),
        new NoopRawContentCodec(), CFG,
        { userId: USER, documentId: id, body: PAYLOAD, contentType: 'application/octet-stream' },
      );
    } finally {
      restore();
    }
    const accepted = findFilecoinEvent(events, 'filecoin.upload.accepted');
    expect(accepted!.detail.statusAfter).toBe('blob_pending');
  });
});

describe('upload observability — provider gating (review-fix HIGH 3)', () => {
  it('local_fs upload emits ZERO [FILECOIN] events', async () => {
    const id = await seedDoc('upload-obs-localfs');
    const { events, restore } = captureFilecoinEvents();
    try {
      await uploadRawDocument(
        pool, makeLocalFsStore(),
        new NoopRawContentCodec(), CFG,
        { userId: USER, documentId: id, body: PAYLOAD, contentType: 'application/octet-stream' },
      );
    } finally {
      restore();
    }
    expect(events).toEqual([]);
  });

  it('local_fs upload that throws still emits ZERO [FILECOIN] events', async () => {
    const id = await seedDoc('upload-obs-localfs-fail');
    const failing = makeLocalFsStore();
    failing.put = async () => { throw new Error('disk full'); };
    const { events, restore } = captureFilecoinEvents();
    try {
      await uploadRawDocument(
        pool, failing,
        new NoopRawContentCodec(), CFG,
        { userId: USER, documentId: id, body: PAYLOAD, contentType: 'application/octet-stream' },
      ).catch(() => undefined);
    } finally {
      restore();
    }
    expect(events).toEqual([]);
  });
});

describe('upload observability — failure path + sanitization', () => {
  it('emits failed with a sanitized errorMessage when the adapter throws', async () => {
    const id = await seedDoc('upload-obs-failed');
    // Plant a credential-shaped substring in the error so the
    // sanitizer's allowlist is exercised end-to-end. The event MUST
    // NOT carry the planted string.
    const planted = 'did:key:z6MkpZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const err = Object.assign(
      new Error(`http 503 from gateway: ${planted}`),
      { code: 'http_5xx' },
    );
    const { events, restore } = captureFilecoinEvents();
    let thrown: unknown = null;
    try {
      await uploadRawDocument(
        pool, makeFilecoinStore({ throwOnPut: err }),
        new NoopRawContentCodec(), CFG,
        { userId: USER, documentId: id, body: PAYLOAD, contentType: 'application/octet-stream' },
      ).catch((e) => { thrown = e; });
    } finally {
      restore();
    }
    expect(thrown).toBeDefined();
    const failed = findFilecoinEvent(events, 'filecoin.upload.failed');
    expect(failed).toBeDefined();
    expect(failed!.detail.documentId).toBe(id);
    expect(failed!.detail.errorCode).toBe('http_5xx');
    expect(typeof failed!.detail.errorMessage).toBe('string');
    expect(failed!.detail.errorMessage as string).not.toContain(planted);
    expect(failed!.detail.errorMessage as string).toContain('[REDACTED');
    expect(typeof failed!.detail.durationMs).toBe('number');
  });
});
