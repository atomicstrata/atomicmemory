/**
 * @file Shared fixtures for `storage-routes*.test.ts` files.
 *
 * Owns the `bootRouter` helper and the per-suite (schema +
 * ephemeral-server + pool) lifecycle. Split out so the existing
 * `storage-routes.test.ts` and the new
 * `storage-routes-error-envelopes.test.ts` both stay under the
 * workspace 400-LOC test cap without duplicating the router boot
 * boilerplate.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { createStorageRouter } from '../storage.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { RawContentStoreBackendAdapter } from '../../storage/raw-content-store-backend-adapter.js';
import { singleBackendRegistry } from '../../storage/storage-backend-registry.js';
import { StorageService } from '../../services/storage-service.js';
import type { StorageBackend } from '../../storage/storage-backend.js';
import type { PointerUriScheme } from '../../config.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';
import {
  closeEphemeralServer,
  startEphemeralServer,
} from './ephemeral-server.js';

export const ROUTE_USER_A = 'storage-route-user-a';
export const ROUTE_USER_B = 'storage-route-user-b';
export const ROUTE_MAX_UPLOAD_BYTES = 256 * 1024;

export interface SuiteHandle {
  baseUrl: string;
  server: Server;
}

/**
 * Mount the storage router on a fresh ephemeral express app and
 * listen on a random port. Returns the live `baseUrl` + `server`
 * handle the caller closes in `afterAll`. The capabilities
 * snapshot uses the `provider` argument for the deployment-active
 * tag so the cross-endpoint contract stays accurate.
 */
export async function bootStorageRouter(
  service: StorageService,
  provider: string,
): Promise<SuiteHandle> {
  const app: Express = express();
  app.use(
    '/v1/storage',
    createStorageRouter({
      capabilities: {
        activeStore: {
          provider,
          capabilities: {
            addressing: 'location', retrievalConsistency: 'immediate', deleteSemantics: 'delete',
            supportsHead: true, supportsGet: true,
          },
          put: () => Promise.reject(),
          get: () => Promise.reject(),
          head: () => Promise.reject(),
          delete: () => Promise.reject(),
        } as never,
        rawUploadMaxBytes: ROUTE_MAX_UPLOAD_BYTES,
      },
      service,
      managedUploadMaxBytes: ROUTE_MAX_UPLOAD_BYTES,
    }),
  );
  return startEphemeralServer(app);
}

export function makeFakeFilecoinBackend(): StorageBackend {
  return {
    provider: 'filecoin',
    put: async () => { throw new Error('filecoin put should never be called by the route layer'); },
    get: async () => { throw new Error('filecoin get'); },
    head: async () => ({ exists: true, sizeBytes: null, contentType: null }),
    delete: async () => ({ deleted: true, semantics: 'deleted' }),
  };
}

export async function closeHandle(handle: SuiteHandle): Promise<void> {
  await closeEphemeralServer(handle.server);
}

/**
 * Construct the local-fs `StorageService` shape that the three
 * `storage-routes-*.test.ts` suites share. Each suite owns its own
 * tmp directory so test runs do not collide. `pointerSchemes`
 * defaults to a permissive set used by the error-envelopes suite;
 * the in-flight and force-rejection suites pass `['https']` so the
 * scheme allowlist matches their seeded pointer URIs.
 */
export async function createLocalFsStorageService(opts: {
  pool: pg.Pool;
  tmpPrefix: string;
  pointerSchemes: ReadonlyArray<PointerUriScheme>;
}): Promise<{ service: StorageService; storageRoot: string }> {
  const storageRoot = await mkdtemp(join(tmpdir(), opts.tmpPrefix));
  const service = new StorageService({
    pool: opts.pool,
    backendRegistry: singleBackendRegistry(
      new RawContentStoreBackendAdapter(new LocalFsRawContentStore({ root: storageRoot })),
    ),
    pointerSchemes: opts.pointerSchemes,
    storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
  });
  return { service, storageRoot };
}
