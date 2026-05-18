/**
 * Builds the `RawContentStore` instance backing
 * `rawStorageMode='managed_blob'`.
 *
 * The actual cross-field validation happens at config-load time in
 * `src/config.ts` (`validateRawStorageConfig`). This factory trusts
 * the validated config: when `rawStorageMode='managed_blob'` arrives,
 * the provider-specific fields are already non-null. When mode is
 * `pointer_only`, the factory returns `null` and document upload routes
 * report 503 to clients that try to upload anyway — see the route
 * layer for the user-facing error envelope.
 */

import type { RuntimeConfig } from '../config.js';
import { LocalFsRawContentStore } from './local-fs-store.js';
import { S3RawContentStore } from './s3-store.js';
import type { RawContentStore } from './raw-content-store.js';

// NOTE: `providers/filecoin/index.js` is intentionally NOT
// statically imported. It transitively pulls `@filoz/synapse-sdk`
// and `viem`, which are heavy and Filecoin-only. The Phase 2
// lazy-loading contract (harvest plan) requires that non-Filecoin
// deployments (`local_fs`, `s3`, pointer-only) never resolve those
// packages on startup. The dynamic import below fires only when
// `rawStorageProvider === 'filecoin'`. The
// `import-boundary.test.ts` "lazy-loading boundary" describe
// enforces this contract: any static import of
// `providers/filecoin/*` outside this file fails the test.

type RawStorageConfig = Pick<
  RuntimeConfig,
  | 'rawStorageMode'
  | 'rawStorageProvider'
  | 'rawStorageLocalFsRoot'
  | 'rawStorageS3Bucket'
  | 'rawStorageS3Region'
  | 'rawStorageS3Endpoint'
  | 'rawStorageS3AccessKeyId'
  | 'rawStorageS3SecretAccessKey'
  | 'rawStorageDeploymentEnv'
  | 'rawStorageLegacyProviders'
  | 'filecoinProvider'
>;

/**
 * Returns `null` when raw bytes are not stored by core (pointer-only
 * default). Returns a configured adapter when
 * `rawStorageMode='managed_blob'`.
 *
 * Async because some providers (e.g. the Synapse-backed Filecoin
 * client) may need async composition at startup. The current
 * `createFilecoinStorageBackend` is synchronous internally; the
 * async return type preserves the boundary for future
 * providers that need awaitable construction (handshake,
 * credential exchange, etc.) without forcing a signature change.
 */
export async function buildRawContentStore(
  cfg: RawStorageConfig,
): Promise<RawContentStore | null> {
  if (cfg.rawStorageMode !== 'managed_blob') return null;
  if (cfg.rawStorageProvider === 'local_fs') return buildLocalFs(cfg);
  if (cfg.rawStorageProvider === 's3') return buildS3(cfg);
  if (cfg.rawStorageProvider === 'filecoin') {
    if (cfg.filecoinProvider === null) {
      // Defense-in-depth: `parseFilecoinProviderConfig` in
      // `src/config.ts` already enforces "filecoin selected ⇒ full
      // RAW_STORAGE_FILECOIN_* env block", so this branch is
      // unreachable in production. Throw rather than silently
      // construct a half-wired backend that advertises supportsHead
      // / supportsGet but cannot actually perform either.
      throw new Error(
        "buildRawContentStore: rawStorageProvider='filecoin' but filecoinProvider config is null. " +
          'Set the full RAW_STORAGE_FILECOIN_* env block.',
      );
    }
    // Lazy: heavy Filecoin packages (`@filoz/synapse-sdk`, `viem`)
    // resolve ONLY here, never on non-Filecoin startup. The defense-
    // in-depth `cfg.filecoinProvider === null` throw above runs
    // BEFORE the import, so a misconfigured deployment fails fast
    // without pulling the vendor SDK either.
    const { createFilecoinStorageBackend } = await import(
      './providers/filecoin/index.js'
    );
    return createFilecoinStorageBackend(cfg.filecoinProvider);
  }
  // Defense-in-depth: config validation should already have caught this.
  throw new Error(
    `buildRawContentStore: rawStorageMode='managed_blob' but provider is missing/unknown ` +
      `(got '${cfg.rawStorageProvider}'). Fix RAW_STORAGE_PROVIDER and restart.`,
  );
}

function buildLocalFs(cfg: RawStorageConfig): LocalFsRawContentStore {
  if (!cfg.rawStorageLocalFsRoot) {
    throw new Error("buildRawContentStore(local_fs): RAW_STORAGE_LOCAL_FS_ROOT is required.");
  }
  return new LocalFsRawContentStore({ root: cfg.rawStorageLocalFsRoot });
}

function buildS3(cfg: RawStorageConfig): S3RawContentStore {
  if (!cfg.rawStorageS3Bucket || !cfg.rawStorageS3Region
      || !cfg.rawStorageS3AccessKeyId || !cfg.rawStorageS3SecretAccessKey) {
    throw new Error(
      "buildRawContentStore(s3): bucket/region/access-key-id/secret-access-key are all required.",
    );
  }
  return new S3RawContentStore({
    bucket: cfg.rawStorageS3Bucket,
    region: cfg.rawStorageS3Region,
    endpoint: cfg.rawStorageS3Endpoint ?? undefined,
    accessKeyId: cfg.rawStorageS3AccessKeyId,
    secretAccessKey: cfg.rawStorageS3SecretAccessKey,
  });
}

/**
 * Build read-only adapters for any legacy providers configured via
 * `RAW_STORAGE_LEGACY_PROVIDERS`. Composition-root code registers
 * these in the `RawContentStoreRegistry` alongside the active store
 * so cleanup dispatches historical rows to the right adapter (Phase
 * 4a §6 — `local-fs://...` rows on a Filecoin-active deployment
 * still need a registered `local_fs` adapter to run their DELETE).
 *
 * `validateRawStorageConfig` already enforced that every named legacy
 * provider has its full env block; this function trusts that
 * validation and re-runs the per-provider builder. Returns an empty
 * array when the operator hasn't configured any legacy providers —
 * the common single-provider deployment.
 */
export function buildLegacyStores(cfg: RawStorageConfig): ReadonlyArray<RawContentStore> {
  return cfg.rawStorageLegacyProviders.map((provider) => {
    if (provider === 'local_fs') return buildLocalFs(cfg);
    if (provider === 's3') return buildS3(cfg);
    // Defense-in-depth: validation already rejects 'filecoin' here.
    throw new Error(`buildLegacyStores: provider '${provider}' is not registerable as legacy.`);
  });
}
