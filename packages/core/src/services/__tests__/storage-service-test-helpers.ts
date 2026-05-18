/**
 * @file Shared test helpers for StorageService integration suites.
 */

import { afterAll, beforeAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import type { PointerUriScheme } from '../../config.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { RawContentStoreBackendAdapter } from '../../storage/raw-content-store-backend-adapter.js';
import { singleBackendRegistry } from '../../storage/storage-backend-registry.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import { StorageService } from '../storage-service.js';

const DEFAULT_POINTER_SCHEMES = ['https', 's3', 'gs', 'ipfs'] as const;

export interface StorageRootFixture {
  storageRoot: string;
}

export interface StorageServiceFixture extends StorageRootFixture {
  localFsBackend: StorageBackend;
  service: StorageService;
}

interface StorageFixtureOptions {
  tempPrefix: string;
  pointerSchemes?: readonly PointerUriScheme[];
}

interface StubBackendOptions {
  provider: string;
  putError?: string;
  getError?: string;
  deleteError?: string;
}

interface LinkedPointerDocumentInput {
  artifactId: string;
  userId: string;
  externalId: string;
  externalUri?: string;
}

export function useStorageRootFixture(tempPrefix: string): StorageRootFixture {
  const fixture = {} as StorageRootFixture;
  beforeAll(async () => {
    await setupTestSchema(pool);
    fixture.storageRoot = await mkdtemp(join(tmpdir(), tempPrefix));
  });
  beforeEach(async () => {
    await clearDocumentTables(pool);
  });
  afterAll(async () => {
    if (fixture.storageRoot === undefined) return;
    await rm(fixture.storageRoot, { recursive: true, force: true });
    await pool.end();
  });
  return fixture;
}

export function useStorageServiceFixture(options: StorageFixtureOptions): StorageServiceFixture {
  const fixture = useStorageRootFixture(options.tempPrefix) as StorageServiceFixture;
  beforeAll(() => {
    fixture.localFsBackend = createLocalFsBackend(fixture.storageRoot);
    fixture.service = createStorageService(fixture.localFsBackend, options.pointerSchemes);
  });
  return fixture;
}

export function createLocalFsBackend(storageRoot: string): StorageBackend {
  return new RawContentStoreBackendAdapter(new LocalFsRawContentStore({ root: storageRoot }));
}

export function createStorageService(
  backend: StorageBackend | null,
  pointerSchemes: readonly PointerUriScheme[] = DEFAULT_POINTER_SCHEMES,
): StorageService {
  return createStorageServiceWithPool(pool, backend, pointerSchemes);
}

export function createStorageServiceWithPool(
  storagePool: typeof pool,
  backend: StorageBackend | null,
  pointerSchemes: readonly PointerUriScheme[] = DEFAULT_POINTER_SCHEMES,
): StorageService {
  return new StorageService({
    pool: storagePool,
    backendRegistry: singleBackendRegistry(backend),
    pointerSchemes: [...pointerSchemes],
    storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
  });
}

export function makeStubStorageBackend(options: StubBackendOptions): StorageBackend {
  return {
    provider: options.provider,
    put: async () => { throw new Error(options.putError ?? `test stub: ${options.provider} put`); },
    get: async () => { throw new Error(options.getError ?? `test stub: ${options.provider} get`); },
    head: async () => ({ exists: true, sizeBytes: null, contentType: null }),
    delete: async () => {
      if (options.deleteError !== undefined) throw new Error(options.deleteError);
      return { deleted: true, semantics: 'deleted' };
    },
  };
}

export async function seedPointerArtifact(
  service: StorageService,
  userId: string,
  uri: string,
): Promise<string> {
  const row = await service.putPointer({ userId, uri, contentType: 'text/plain' });
  return row.id;
}

export async function seedLinkedPointerDocument(
  input: LinkedPointerDocumentInput,
): Promise<string> {
  const source = await upsertRawSource(pool, {
    userId: input.userId,
    sourceSite: 'drive',
    provider: 'google-drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: input.userId,
    rawSourceId: source.id,
    externalId: input.externalId,
    storageMode: 'pointer_only',
    externalUri: input.externalUri ?? 'https://example.com/doc.pdf',
  });
  await pool.query(
    `UPDATE raw_documents SET storage_artifact_id = $1 WHERE id = $2`,
    [input.artifactId, reg.document.id],
  );
  return reg.document.id;
}
