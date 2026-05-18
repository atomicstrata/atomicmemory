/**
 * @file Opt-in live integration test for encrypted document uploads to
 * Filecoin. This sits above the provider smoke tests: it runs the
 * document upload pipeline with a real Filecoin `RawContentStore` and
 * AES-GCM codec, then verifies the remote bytes are ciphertext and
 * decode back to the original plaintext.
 *
 * Gates:
 *   - `FILECOIN_LIVE_DOCUMENT_UPLOAD_TESTS=1` enables the suite.
 *   - `RAW_STORAGE_FILECOIN_*` must point at calibration credentials.
 *
 * Recommended invocation:
 *
 *   FILECOIN_LIVE_DOCUMENT_UPLOAD_TESTS=1 \
 *     dotenv -e .env.test -e .env.foc.local -- npx vitest run \
 *     "src/services/__tests__/document-upload-filecoin-live.test.ts" \
 *     --reporter=verbose --testTimeout=900000
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { getRawDocumentById, registerRawDocument, upsertRawSource } from '../../db/raw-document-repository.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import { AesGcmRawContentCodec } from '../../storage/codecs/aes-gcm-codec.js';
import type { InternalRawContentCodecMetadata } from '../../storage/raw-content-codec.js';
import type { RawContentHints, RawContentStore } from '../../storage/raw-content-store.js';
import type { FilecoinProviderConfig } from '../../storage/providers/filecoin/config.js';
import { uploadRawDocument } from '../document-upload.js';

const LIVE = process.env['FILECOIN_LIVE_DOCUMENT_UPLOAD_TESTS'] === '1';
const USER = 'filecoin-encrypted-upload-live';
const CFG = {
  rawStoragePrefix: 'live-filecoin-doc-upload',
  rawStorageMode: 'managed_blob' as const,
  storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
};
const TEST_KEY = Buffer.alloc(32, 0x13);
const TIMEOUT_MS = 900_000;
// Mirrors the current Synapse SDK `SIZE_CONSTANTS.MIN_UPLOAD_SIZE`
// without importing the heavy vendor package outside providers/filecoin.
const SYNAPSE_MIN_UPLOAD_BYTES = 127;

let store: RawContentStore;
let config: FilecoinProviderConfig;
let uploadedUri: string | null = null;
let uploadedHints: RawContentHints | null = null;

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function assertCalibration(cfg: FilecoinProviderConfig): void {
  if (cfg.network === 'calibration') return;
  throw new Error(
    `document-upload-filecoin-live refuses network='${cfg.network}'. ` +
      'Set RAW_STORAGE_FILECOIN_NETWORK=calibration.',
  );
}

function minUploadPayload(cfg: FilecoinProviderConfig): Buffer {
  const size = cfg.minUploadBytes ?? SYNAPSE_MIN_UPLOAD_BYTES;
  return Buffer.alloc(size, 0x45);
}

function filecoinHints(metadata: Record<string, unknown>): RawContentHints {
  const filecoin = metadata['filecoin'];
  if (!filecoin || typeof filecoin !== 'object' || Array.isArray(filecoin)) {
    throw new Error('raw_storage_metadata.filecoin missing after live upload');
  }
  return { filecoin: filecoin as Record<string, unknown> };
}

async function seedDoc(externalId: string): Promise<string> {
  const source = await upsertRawSource(pool, {
    userId: USER,
    sourceSite: 'live-filecoin',
    provider: 'integration-test',
  });
  const registration = await registerRawDocument(pool, {
    userId: USER,
    rawSourceId: source.id,
    externalId,
  });
  return registration.document.id;
}

describe.skipIf(!LIVE)('uploadRawDocument + Filecoin + AES-GCM live integration', () => {
  beforeAll(async () => {
    await setupTestSchema(pool);
    const [{ parseFilecoinProviderConfig }, { createFilecoinStorageBackend }] = await Promise.all([
      import('../../storage/providers/filecoin/config.js'),
      import('../../storage/providers/filecoin/index.js'),
    ]);
    config = parseFilecoinProviderConfig(process.env);
    assertCalibration(config);
    store = await createFilecoinStorageBackend(config);
  }, TIMEOUT_MS);

  beforeEach(async () => {
    uploadedUri = null;
    uploadedHints = null;
    await clearDocumentTables(pool);
  });

  afterAll(async () => {
    if (uploadedUri && uploadedHints) {
      const result = await store.delete(uploadedUri, uploadedHints);
      expect(result.semantics).toBe('tombstoned');
    }
    await clearDocumentTables(pool);
    await pool.end();
  }, TIMEOUT_MS);

  it('uploads ciphertext to Filecoin and decodes retrieved bytes to the original document', async () => {
    const plaintext = minUploadPayload(config);
    const documentId = await seedDoc('encrypted-live-doc');
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'test-v1', key: TEST_KEY }],
      activeKeyId: 'test-v1',
    });
    const result = await uploadRawDocument(pool, store, codec, CFG, {
      userId: USER,
      documentId,
      body: plaintext,
    });

    uploadedUri = result.storageUri;
    uploadedHints = filecoinHints(result.rawStorageMetadata);
    expect(result.storageProvider).toBe('filecoin');
    expect(result.storageUri).toMatch(/^filecoin:\/\/piece\/.+$/);
    expect(result.contentHash).toBe(sha256Hex(plaintext));
    expect(result.rawStorageMetadata.codec).toMatchObject({
      name: 'aes_gcm',
      version: 1,
      key_id: 'test-v1',
    });

    const row = await getRawDocumentById(pool, USER, documentId);
    expect(row?.rawStorageMetadata).toEqual(result.rawStorageMetadata);
    const providerBytes = await store.get(result.storageUri);
    expect(providerBytes.body.equals(plaintext)).toBe(false);

    const decoded = await codec.decode({
      body: providerBytes.body,
      metadata: result.rawStorageMetadata.codec as InternalRawContentCodecMetadata,
    });
    expect(decoded.body.equals(plaintext)).toBe(true);
  }, TIMEOUT_MS);
});

describe.skipIf(LIVE)('uploadRawDocument + Filecoin + AES-GCM live integration — gated off by default', () => {
  it('skips unless FILECOIN_LIVE_DOCUMENT_UPLOAD_TESTS=1', () => {
    expect(LIVE).toBe(false);
  });
});
