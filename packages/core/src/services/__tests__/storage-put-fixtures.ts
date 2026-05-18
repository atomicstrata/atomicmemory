/**
 * @file Shared fixtures for `storage-service-put*.test.ts` files.
 *
 * Centralises the per-suite pool / backend / tmpdir lifecycle.
 * Pool-wrapping helpers (`wrapPoolFailingRecord`,
 * `wrapPoolCommitThenThrow`, `wrapPoolCasMiss`) are NOT re-exported
 * here — tests import them from
 * `src/__tests__/helpers/pool-wrappers.ts` directly so the neutral
 * helper is the only source of truth.
 */

import { beforeAll } from 'vitest';
import type { StorageBackend } from '../../storage/storage-backend.js';
import {
  createLocalFsBackend,
  useStorageRootFixture,
} from './storage-service-test-helpers.js';

export const USER = 'storage-put-lifecycle-user';

interface PutFixtures {
  /** Active local_fs backend constructed against `storageRoot`. */
  readonly localFsBackend: StorageBackend;
  /**
   * Path to the suite-owned temp dir. Tests that need to build
   * *additional* `LocalFsRawContentStore` instances (e.g. a
   * tracking wrapper around the real backend) MUST root them at
   * this path so the directory's contents are cleaned up by the
   * suite's `afterAll`. No `process.env.TMPDIR` fallbacks; the
   * fixture owns the lifecycle.
   */
  readonly storageRoot: string;
}

/**
 * Wires `beforeAll`/`beforeEach`/`afterAll` for a put-suite test
 * file: schema setup, fresh temp dir per file, table cleanup
 * before each test, and tear-down at the end. The returned getter
 * exposes the live backend + storageRoot after `beforeAll` runs.
 */
export function usePutFixtures(): () => PutFixtures {
  const fixture = useStorageRootFixture('storage-put-') as {
    storageRoot: string;
    localFsBackend: StorageBackend;
  };
  beforeAll(async () => {
    fixture.localFsBackend = createLocalFsBackend(fixture.storageRoot);
  });
  return () => fixture;
}
