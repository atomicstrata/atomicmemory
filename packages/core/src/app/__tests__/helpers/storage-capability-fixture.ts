/**
 * @file Shared fixture for the composition-root capability tests.
 *
 * `document-limits-capabilities.test.ts` and `storage-capabilities-app.test.ts`
 * both:
 *   - set up the test schema once,
 *   - create a temp `storageRoot` directory for `managed_blob` boots,
 *   - boot an ephemeral `createApp(createCoreRuntime(...))` against
 *     per-test config overrides,
 *   - tear the booted app down between tests and remove the temp dir
 *     plus pool at the end of the file.
 *
 * Extracted here so the two test files don't carry the lifecycle plumbing
 * and `bootWith` body verbatim. Each caller wires the vitest hooks itself
 * (so collection happens against the right file) and receives a small
 * accessor object scoped to that file's lifetime.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../../db/pool.js';
import { setupTestSchema } from '../../../db/__tests__/test-fixtures.js';
import { config as defaultConfig, type RuntimeConfig } from '../../../config.js';
import { createCoreRuntime } from '../../runtime-container.js';
import { createApp } from '../../create-app.js';
import { bindEphemeral, type BootedApp } from '../../bind-ephemeral.js';

interface LifecycleHooks {
  beforeAll: (fn: () => Promise<void>) => void;
  afterEach: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}

export interface StorageCapabilityFixture {
  /** Boot `createApp` against the supplied config overrides. */
  bootWith: (overrides: Partial<RuntimeConfig>) => Promise<BootedApp>;
  /** Path to the per-file temp `mkdtemp` dir; valid after `beforeAll` runs. */
  storageRoot: () => string;
}

/**
 * Register the shared schema/tempdir/booted lifecycle hooks against the
 * calling test file and return helpers bound to that file-scoped temp
 * dir. Call once at module load in the test file.
 */
export function useStorageCapabilityFixture(
  hooks: LifecycleHooks,
  tmpPrefix: string,
): StorageCapabilityFixture {
  let storageRoot = '';
  let booted: BootedApp | null = null;

  hooks.beforeAll(async () => {
    await setupTestSchema(pool);
    storageRoot = await mkdtemp(join(tmpdir(), tmpPrefix));
  });

  hooks.afterEach(async () => {
    if (booted) {
      await booted.close();
      booted = null;
    }
  });

  hooks.afterAll(async () => {
    if (storageRoot) {
      await rm(storageRoot, { recursive: true, force: true });
    }
    await pool.end();
  });

  return {
    bootWith: async (overrides) => {
      const cfg = { ...defaultConfig, ...overrides };
      booted = await bindEphemeral(createApp(await createCoreRuntime({ pool, config: cfg })));
      return booted;
    },
    storageRoot: () => storageRoot,
  };
}
