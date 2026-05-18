/**
 * Verify the wipe path
 * (`PgMemoryStore.deleteAll` and `MemoryRepository.deleteAll`)
 * dispatches per-row by the registered provider, not by a single
 * active store. Older helpers only forwarded
 * `rawContentStore` to `repository-write.deleteAll`, which wrapped it
 * in `singleStoreRegistry(rawContentStore)` — legacy-provider rows
 * would fail with "no adapter registered" instead of routing to the
 * legacy adapter.
 *
 * Strategy: seed a single managed-blob row whose `storage_provider`
 * is a synthetic `legacy_fake`. Construct the store/repo with an
 * active local_fs adapter PLUS a `legacy_fake` adapter registered in
 * the registry. Call `deleteAll(userId)` and assert the legacy
 * adapter's `delete()` was invoked — the active adapter MUST NOT be
 * called for the legacy URI.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../../db/pool.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import { LocalFsRawContentStore } from '../local-fs-store.js';
import { buildStoreRegistry, singleStoreRegistry } from '../store-registry.js';
import { PgMemoryStore } from '../../db/pg-memory-store.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import type { RawContentStore } from '../raw-content-store.js';

const USER = 'phase4a-wipe-registry-user';

let storageRoot: string;
let activeStore: LocalFsRawContentStore;

function makeLegacyAdapter(): RawContentStore & { deleteSpy: ReturnType<typeof vi.fn> } {
  const deleteSpy = vi.fn(async () => ({ deleted: true, semantics: 'deleted' as const }));
  return {
    provider: 'legacy_fake',
    capabilities: {
      addressing: 'location' as const,
      retrievalConsistency: 'immediate' as const,
      deleteSemantics: 'delete' as const,
      supportsHead: true,
      supportsGet: true,
    },
    put: async () => { throw new Error('legacy_fake.put not used in test'); },
    get: async () => { throw new Error('legacy_fake.get not used in test'); },
    head: async () => ({ exists: false, metadata: null }),
    delete: deleteSpy,
    deleteSpy,
  };
}

async function seedLegacyRow(externalId: string): Promise<void> {
  const src = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'legacy-test', provider: 'legacy-test',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId,
  });
  // Manually flip the row to managed_blob with a legacy provider URI.
  // per-row provider dispatch's wipe-path dispatcher must route this row to the
  // legacy adapter at the cleanup boundary.
  await pool.query(
    `UPDATE raw_documents
        SET storage_mode = 'managed_blob',
            storage_provider = 'legacy_fake',
            storage_uri = $1,
            raw_storage_status = 'blob_stored',
            content_hash = $2,
            size_bytes = 4,
            raw_storage_metadata = '{}'::jsonb
      WHERE id = $3`,
    [`legacy_fake://${externalId}.bin`, 'a'.repeat(64), reg.document.id],
  );
}

beforeAll(async () => {
  await setupTestSchema(pool);
  storageRoot = await mkdtemp(join(tmpdir(), 'atomicmem-wipe-registry-'));
  activeStore = new LocalFsRawContentStore({ root: storageRoot });
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PgMemoryStore.deleteAll — registry-based provider dispatch (per-row provider dispatch §6)', () => {
  it('dispatches a legacy-provider row through the registered legacy adapter', async () => {
    await seedLegacyRow('pgstore-legacy-1');
    const legacy = makeLegacyAdapter();
    const registry = buildStoreRegistry(activeStore, [legacy]);
    const store = new PgMemoryStore(pool, { rawContentStore: activeStore, storeRegistry: registry });
    await store.deleteAll(USER);
    expect(legacy.deleteSpy).toHaveBeenCalledWith('legacy_fake://pgstore-legacy-1.bin', {});
  });

  it('without a registry, legacy-provider cleanup fails loudly (backcompat fallback to singleStoreRegistry)', async () => {
    await seedLegacyRow('pgstore-no-registry-1');
    // No registry passed → falls back to singleStoreRegistry(activeStore),
    // which doesn't know `legacy_fake` → cleanup raises.
    const store = new PgMemoryStore(pool, { rawContentStore: activeStore });
    await expect(store.deleteAll(USER)).rejects.toThrow(/legacy_fake/);
  });
});

describe('MemoryRepository.deleteAll — registry-based provider dispatch (per-row provider dispatch §6)', () => {
  it('dispatches a legacy-provider row through the registered legacy adapter', async () => {
    await seedLegacyRow('repo-legacy-1');
    const legacy = makeLegacyAdapter();
    const registry = buildStoreRegistry(activeStore, [legacy]);
    const repo = new MemoryRepository(pool, { rawContentStore: activeStore, storeRegistry: registry });
    await repo.deleteAll(USER);
    expect(legacy.deleteSpy).toHaveBeenCalledWith('legacy_fake://repo-legacy-1.bin', {});
  });

  it('without a registry, legacy-provider cleanup fails loudly (backcompat fallback)', async () => {
    await seedLegacyRow('repo-no-registry-1');
    const repo = new MemoryRepository(pool, { rawContentStore: activeStore });
    await expect(repo.deleteAll(USER)).rejects.toThrow(/legacy_fake/);
  });

  it('with only the legacy registered (active=null), legacy cleanup still succeeds', async () => {
    // Verifies the registry path doesn't depend on the active store
    // being non-null — a pointer-only deployment that still needs to
    // clean up historical managed-blob rows works through the
    // legacy-only registry.
    await seedLegacyRow('repo-active-null-1');
    const legacy = makeLegacyAdapter();
    const registry = buildStoreRegistry(null, [legacy]);
    const repo = new MemoryRepository(pool, { rawContentStore: null, storeRegistry: registry });
    await repo.deleteAll(USER);
    expect(legacy.deleteSpy).toHaveBeenCalledWith('legacy_fake://repo-active-null-1.bin', {});
  });

  it('singleStoreRegistry(activeStore) (the documented pre-Phase-4a-fix fallback) reproduces the same failure', async () => {
    // Lock the regression: the old wiring (passing only rawContentStore)
    // is equivalent to singleStoreRegistry(activeStore), which the
    // legacy row hits with "no adapter registered". A future
    // accidental drop of the `storeRegistry` thread-through would
    // re-introduce this failure mode.
    await seedLegacyRow('repo-regression-1');
    const repo = new MemoryRepository(pool, {
      rawContentStore: activeStore,
      storeRegistry: singleStoreRegistry(activeStore),
    });
    await expect(repo.deleteAll(USER)).rejects.toThrow(/legacy_fake/);
  });
});
