/**
 * Shared composition fixtures for the document-router test files.
 *
 * The four route-level test files (`documents.test.ts`,
 * `document-index-route.test.ts`, `document-raw-route.test.ts`, and
 * `response-schema-coverage.test.ts`) all instantiate
 * `createDocumentRouter` with the same shape of options. Centralising
 * the fixture here keeps the test-app boilerplate identical and stops
 * fallow's clone detector from flagging the duplicated option block.
 *
 * The defaults match the production semantics for a `pointer_only`
 * deployment: a 1 MiB raw-upload cap (small for fast-running tests),
 * the production `MAX_INDEX_TEXT_BYTES` ceiling, and a disabled
 * managed-blob surface. Individual tests can override per-fixture
 * fields by passing a partial override to `documentRouterFixture`.
 */

import express, { type Express } from 'express';
import type pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { MAX_INDEX_TEXT_BYTES } from '../../schemas/documents.js';
import { DocumentService } from '../../services/document-service.js';
import { LocalFsRawContentStore } from '../../storage/local-fs-store.js';
import { createDocumentRouter, type DocumentRouterOptions } from '../documents.js';
import { TEST_STORAGE_KEY_HMAC_SECRET } from '../../__tests__/helpers/storage-key-test-secret.js';

const TEST_RAW_UPLOAD_MAX_BYTES = 1024 * 1024;

export function documentRouterFixture(
  overrides: {
    rawUploadMaxBytes?: number;
    rawStorage?: DocumentRouterOptions['limits']['rawStorage'];
  } = {},
): DocumentRouterOptions {
  const rawUploadMaxBytes = overrides.rawUploadMaxBytes ?? TEST_RAW_UPLOAD_MAX_BYTES;
  const rawStorage =
    overrides.rawStorage ?? { enabled: false, mode: 'pointer_only', reason: 'test fixture' };
  return {
    rawUploadMaxBytes,
    limits: {
      rawUploadMaxBytes,
      indexMaxTextBytes: MAX_INDEX_TEXT_BYTES,
      rawStorage,
    },
  };
}

interface EphemeralServerHandle {
  /**
   * The base URL of the test HTTP server. Available inside `it`
   * blocks AFTER `beforeAll` has run; calling before that throws.
   */
  baseUrl(): string;
}

/**
 * Wire the standard ephemeral-server lifecycle for a route-level
 * document test file: setup schema, listen on a random port, capture
 * the base URL, clear document tables before each test, and tear the
 * server + pool down afterwards.
 *
 * Centralising this stops fallow flagging the (otherwise verbatim)
 * `app.listen` / `server.close` / `pool.end` boilerplate that
 * `documents.test.ts` and `document-index-route.test.ts` both used
 * to inline.
 *
 * Call from FILE TOP LEVEL (not inside a `describe`) so the lifecycle
 * applies to every test in the file, mirroring the contract of
 * `useDocumentIndexerLifecycle` in the service-layer tests.
 */
export function useEphemeralDocumentServer(
  app: Express,
  pool: pg.Pool,
): EphemeralServerHandle {
  // Hook-ordering contract (vitest: `beforeAll` runs in FIFO,
  // `afterAll` runs in LIFO). We need:
  //   beforeAll  → setupTestSchema, then app.listen
  //   afterAll   → server.close, then pool.end
  // Registration order achieves both:
  //   1. beforeAll(setupTestSchema)                  ← FIFO: 1st
  //   2. afterAll(pool.end)                          ← LIFO: 2nd (runs last)
  //   3. useRandomPortListener registers
  //        beforeAll(app.listen)                     ← FIFO: 2nd
  //        afterAll(server.close)                    ← LIFO: 1st (runs first)
  // Cleanup order is the important one — close the live server
  // BEFORE ending the pool so a request still in flight when
  // afterAll fires doesn't hit a closed pool.
  beforeAll(async () => {
    await setupTestSchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  const handle = useRandomPortListener(app);
  beforeEach(async () => {
    await clearDocumentTables(pool);
  });
  return { baseUrl: handle.baseUrl };
}

/**
 * Phase 8.6 — composite setup for a managed-blob raw-upload route
 * test: mounts a `local_fs`-backed `DocumentService` on an
 * ephemeral Express server with a configurable
 * `rawUploadMaxBytes`. Returns the live `baseUrl()` getter; the
 * tmpdir + server lifecycle are owned by the helper so the test
 * file no longer carries the `mkdtemp + listen + close + rm` boilerplate
 * fallow flagged as a clone.
 */
export function useManagedBlobApp(
  pool: pg.Pool,
  opts: { rawUploadMaxBytes: number; storagePrefix?: string },
): { baseUrl(): string } {
  // Hook-ordering contract (see `useEphemeralDocumentServer` above):
  //   beforeAll  → setupTestSchema + mkdtemp + service mount, THEN
  //                app.listen via useRandomPortListener.
  //   afterAll   → server.close FIRST (via useRandomPortListener,
  //                LIFO-registered last), THEN clearTables + pool.end
  //                + rmdir.
  const app = express();
  let storageRoot: string | null = null;
  beforeAll(async () => {
    await setupTestSchema(pool);
    storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-managed-blob-'));
    const store = new LocalFsRawContentStore({ root: storageRoot });
    const service = new DocumentService(pool, {
      rawContentStore: store,
      config: {
        rawStoragePrefix: opts.storagePrefix ?? 'test',
        rawStorageMode: 'managed_blob', storageKeyHmacSecret: TEST_STORAGE_KEY_HMAC_SECRET,
      },
    });
    app.use(
      '/documents',
      createDocumentRouter(
        service,
        documentRouterFixture({
          rawUploadMaxBytes: opts.rawUploadMaxBytes,
          rawStorage: { enabled: true, mode: 'managed_blob' },
        }),
      ),
    );
  });
  afterAll(async () => {
    await clearDocumentTables(pool);
    await pool.end();
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
  const handle = useRandomPortListener(app);
  beforeEach(async () => {
    await clearDocumentTables(pool);
  });
  return { baseUrl: handle.baseUrl };
}

/**
 * Internal — shared `listen on port 0 + capture baseUrl + close on
 * teardown` lifecycle used by every ephemeral-server helper in this
 * file. Registers its own `beforeAll` (app.listen) + `afterAll`
 * (server.close).
 *
 * Caller-managed registration order (vitest: `beforeAll` runs in
 * FIFO, `afterAll` runs in LIFO):
 *
 *   1. Caller registers `beforeAll(setupTestSchema + any mount work)`.
 *   2. Caller registers `afterAll(pool.end / rmdir / etc.)`.
 *   3. Caller invokes `useRandomPortListener(app)` — which appends
 *      `beforeAll(listen)` + `afterAll(server.close)`.
 *
 * Run order then becomes:
 *   beforeAll FIFO  → setupSchema/mount → listen
 *   afterAll  LIFO  → server.close      → pool.end/rmdir/etc.
 *
 * Closing the live server BEFORE ending the pool guarantees any
 * request in flight when teardown fires doesn't hit a closed pool.
 */
function useRandomPortListener(app: Express): { baseUrl(): string } {
  let server: ReturnType<Express['listen']> | null = null;
  let captured: string | null = null;
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        captured = `http://localhost:${port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
  return {
    baseUrl: () => {
      if (captured === null) {
        throw new Error('useRandomPortListener: baseUrl() called before beforeAll completed');
      }
      return captured;
    },
  };
}
