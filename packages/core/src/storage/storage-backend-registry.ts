/**
 * @file Per-row `StorageBackend` registry — direct-storage parallel
 * to `RawContentStoreRegistry`.
 *
 * The storage service's read/delete/verify paths dispatch on the
 * artifact row's `provider` column, NOT on the deployment's active
 * backend, so a row written when the deployment was on `local_fs`
 * keeps working after the operator switches to `s3`. Pointer rows
 * short-circuit before the registry is even consulted (no backend
 * required for `mode='pointer'`); only managed rows go through
 * `get(provider)`.
 *
 * Failure semantics: a managed row whose provider is not registered
 * is an operational unavailability (the deployment dropped a
 * provider that still has live data). The service translates the
 * `BackendNotRegisteredError` lookup miss into HTTP 503
 * `storage_backend_unavailable` — see `src/routes/storage.ts`. The
 * registry itself returns `undefined`; callers MUST fail loud.
 */

import type { StorageBackend } from './storage-backend.js';

export interface StorageBackendRegistry {
  /**
   * The backend the deployment writes NEW managed artifacts to.
   * Returns `null` when the deployment is pointer-only (no managed
   * uploads); pointer artifacts still work because they
   * short-circuit before backend lookup.
   */
  readonly active: StorageBackend | null;

  /**
   * Look up the backend matching `storage_artifacts.provider`.
   * Returns `undefined` when no adapter is registered for that
   * provider. Callers (the storage service's read/delete/verify
   * paths) MUST translate `undefined` into a typed error rather
   * than fall through to the active backend.
   */
  get(provider: string): StorageBackend | undefined;

  /** True when `provider` has a registered backend in this registry. */
  has(provider: string): boolean;

  /**
   * `(provider, backend)` pairs the registry knows about. Iteration
   * order is the order providers were registered (active first,
   * then legacy adapters).
   */
  readonly entries: ReadonlyArray<readonly [string, StorageBackend]>;
}

/**
 * Build a backend registry from the active backend + optional
 * legacy read-only adapters. `active` is `null` for pointer-only
 * deployments. Throws when the same provider id is registered
 * twice; that's a composition bug the caller must fix.
 */
export function buildBackendRegistry(
  active: StorageBackend | null,
  legacy: ReadonlyArray<StorageBackend> = [],
): StorageBackendRegistry {
  const map = new Map<string, StorageBackend>();
  if (active) map.set(active.provider, active);
  for (const backend of legacy) {
    if (map.has(backend.provider)) {
      throw new Error(
        `StorageBackendRegistry: provider '${backend.provider}' is registered twice. ` +
          `Active='${active?.provider ?? 'none'}', legacy contains a duplicate.`,
      );
    }
    map.set(backend.provider, backend);
  }
  const entries = Array.from(map.entries()) as ReadonlyArray<readonly [string, StorageBackend]>;
  return {
    active,
    entries,
    get(provider: string): StorageBackend | undefined {
      return map.get(provider);
    },
    has(provider: string): boolean {
      return map.has(provider);
    },
  };
}

/**
 * Convenience for unit tests + single-provider deployments. Wraps
 * one already-constructed backend (or `null` for pointer-only) in a
 * registry with no legacy entries.
 */
export function singleBackendRegistry(backend: StorageBackend | null): StorageBackendRegistry {
  return buildBackendRegistry(backend, []);
}
