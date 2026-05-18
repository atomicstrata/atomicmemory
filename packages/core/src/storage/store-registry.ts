/**
 * Per-row `RawContentStore` registry (Phase 4a). The composition root
 * builds one registry from the active provider plus any legacy
 * read-only adapters (`RAW_STORAGE_LEGACY_PROVIDERS`). Cleanup helpers
 * dispatch on `blob.storageProvider` — a `local-fs://...` row on a
 * Filecoin-active deployment is served by the registered legacy
 * `local_fs` adapter, NOT by the active Filecoin store.
 *
 * Why this exists (rev-4 §6): pre-Filecoin, every row carried the
 * same provider as the active adapter, so `cleanupManagedBlobs(store,
 * blobs)` was sufficient. Once Filecoin lands alongside legacy s3 /
 * local_fs rows, the active store may not be able to parse the
 * historical URIs — silent-no-op (or `RawStorageUriError`) would be
 * confusing. The registry fails loud when a row carries a provider
 * the deployment hasn't registered.
 *
 * Capability lookup: `getDeleteSemantics` resolves
 * `provider → 'delete' | 'unpin' | 'tombstone'` for the per-row
 * `delete_semantics` wire field Phase 7a emits. Reads from the
 * registered adapter's `capabilities.deleteSemantics`.
 */

import type { RawContentStore } from './raw-content-store.js';

export interface RawContentStoreRegistry {
  /**
   * Adapter the deployment writes NEW rows to. Returns `null` when
   * the deployment is pointer-only (no managed-blob writes).
   */
  readonly active: RawContentStore | null;

  /**
   * Look up an adapter by `raw_documents.storage_provider`. Returns
   * `undefined` when the provider isn't registered — caller MUST
   * fail loud rather than fall through to the active store.
   */
  get(provider: string): RawContentStore | undefined;

  /**
   * `(provider, store)` pairs the registry knows about. Used by the
   * `/limits` route + observability surfaces; iteration order is the
   * order providers were registered (active first, then legacy).
   */
  readonly entries: ReadonlyArray<readonly [string, RawContentStore]>;
}

/**
 * Build a registry from the active store + any legacy read-only
 * adapters. `active` may be `null` for pointer-only deployments;
 * `legacy` defaults to an empty array.
 *
 * Defensive: registering the SAME provider twice (e.g. active=s3 +
 * legacy=s3) throws — that's a config bug the operator must fix.
 * `validateRawStorageConfig` already enforces this at startup, but the
 * registry checks again so direct construction (tests, composition
 * harnesses) can't drift.
 */
export function buildStoreRegistry(
  active: RawContentStore | null,
  legacy: ReadonlyArray<RawContentStore> = [],
): RawContentStoreRegistry {
  const map = new Map<string, RawContentStore>();
  if (active) {
    map.set(active.provider, active);
  }
  for (const store of legacy) {
    if (map.has(store.provider)) {
      throw new Error(
        `RawContentStoreRegistry: provider '${store.provider}' is registered twice. ` +
          `Active=${active?.provider ?? 'none'}, legacy contains a duplicate. ` +
          `Check RAW_STORAGE_PROVIDER and RAW_STORAGE_LEGACY_PROVIDERS.`,
      );
    }
    map.set(store.provider, store);
  }
  const entries = Array.from(map.entries()) as ReadonlyArray<readonly [string, RawContentStore]>;
  return {
    active,
    entries,
    get(provider: string): RawContentStore | undefined {
      return map.get(provider);
    },
  };
}

/**
 * Lookup helper: returns the registered adapter's
 * `capabilities.deleteSemantics` for the given provider, or `null`
 * when the provider isn't registered (pointer-only row, or a stale
 * provider the deployment doesn't recognize). Phase 7a's formatters
 * project this onto the wire `delete_semantics` field.
 */
export function getDeleteSemantics(
  registry: RawContentStoreRegistry,
  provider: string | null,
): 'delete' | 'unpin' | 'tombstone' | null {
  if (!provider) return null;
  const store = registry.get(provider);
  if (!store) return null;
  return store.capabilities.deleteSemantics;
}

/**
 * Convenience helper for unit tests + single-provider deployments
 * (the common case today). Wraps one already-constructed store in a
 * registry with no legacy entries.
 */
export function singleStoreRegistry(store: RawContentStore | null): RawContentStoreRegistry {
  return buildStoreRegistry(store, []);
}
