/**
 * @file Filecoin storage provider — composition entry point.
 *
 * `createFilecoinStorageBackend(config)` is the single entry point
 * that `src/storage/factory.ts` calls when
 * `rawStorageProvider === 'filecoin'`. The provider REQUIRES a
 * non-null parsed `FilecoinProviderConfig` — the null-config
 * runtime path is not supported now that
 * `head`/`get`/`delete` advertise real capabilities. The central
 * `parseFilecoinProviderConfig` in `src/config.ts` already enforces
 * "filecoin selected ⇒ full env block validated", so production
 * never reaches this entry with a null config.
 *
 * The test client stays isolated in `./skeleton-client.ts` for
 * tests that need a `FilecoinProviderClient`-shaped stub without standing up a real
 * Synapse handle.
 *
 * Reverse import-boundary invariant (enforced by the
 * `import-boundary.test.ts`): this module's only outward imports
 * are sibling files inside `providers/filecoin/`, the adapter
 * contract from `src/storage/raw-content-store.js`, and (inside
 * `synapse-construction.ts`) the vendor packages
 * `@filoz/synapse-sdk` + `viem`. No `RuntimeConfig`, no
 * `process.env`, no route/db/service code.
 */

import { FilecoinRawContentStore } from './backend.js';
import { SynapseFilecoinProviderClient } from './synapse-client.js';
import type { FilecoinProviderConfig } from './config.js';
import { FilecoinProviderError } from './errors.js';
import { buildSynapse } from './synapse-construction.js';
import type { FilecoinProviderClient } from './provider-client.js';
import type { RawContentStore } from '../../raw-content-store.js';

/**
 * Build the Filecoin backend from a validated
 * `FilecoinProviderConfig`. Throws `FilecoinProviderError` when
 * the caller passes a non-config — the only path that can happen
 * in production is a misconfiguration the central config
 * validator should have caught, so the throw is a defense-in-
 * depth signal rather than an expected branch.
 *
 * **Lazy-load contract.** Synchronous construction of the default
 * `synapse` client is fine — its imports (`@filoz/synapse-sdk`,
 * `viem`) are already in this module's static graph. The
 * `filecoin_pin` client, however, pulls a much heavier graph
 * (`filecoin-pin/core/upload`, `@helia/unixfs`, `@ipld/car`,
 * `blockstore-core`), so we `await import` it ONLY inside the
 * `filecoin_pin` branch. A deployment running the default
 * `RAW_STORAGE_FILECOIN_DRIVER=synapse` never resolves the
 * filecoin-pin module subtree at runtime, which keeps the
 * `filecoin-pin` package's `optionalDependencies` status honest
 * (a synapse-only deployment can be built without the package
 * installed at all). The function returns `Promise<RawContentStore>`
 * so the dynamic-import branch can await its loader.
 */
export async function createFilecoinStorageBackend(
  config: FilecoinProviderConfig,
): Promise<RawContentStore> {
  if (config === null || config === undefined) {
    throw new FilecoinProviderError(
      'filecoin_provider_not_configured',
      'createFilecoinStorageBackend was called without a FilecoinProviderConfig. ' +
        'Set the RAW_STORAGE_FILECOIN_* env block before selecting filecoin.',
    );
  }
  const synapse = buildSynapse(config);
  const synapseClient = new SynapseFilecoinProviderClient(synapse, {
    copies: config.copies,
    providerIds: config.providerIds,
    dataSetMetadata: filecoinDataSetMetadataToStrings(config.dataSetMetadata),
    withCdn: config.withCdn,
    uploadTimeoutMs: config.uploadTimeoutMs,
    retrievalTimeoutMs: config.retrievalTimeoutMs,
    minUploadBytes: config.minUploadBytes,
    maxUploadBytes: config.maxUploadBytes,
  });
  let client: FilecoinProviderClient = synapseClient;
  if (config.driver === 'filecoin_pin') {
    // Dynamic import keeps the filecoin-pin module subtree out
    // of the synapse-only startup graph. The boundary test
    // (`__tests__/lazy-loading-boundary.test.ts`) asserts this
    // invariant statically by AST-scanning `index.ts`.
    const { FilecoinPinFilecoinProviderClient } = await import('./filecoin-pin-client.js');
    client = new FilecoinPinFilecoinProviderClient(synapse, synapseClient, {
      ...(config.copies !== null ? { copies: config.copies } : {}),
      providerIds: config.providerIds,
      dataSetMetadata: filecoinDataSetMetadataToStrings(config.dataSetMetadata),
      ...(config.uploadTimeoutMs !== null ? { uploadTimeoutMs: config.uploadTimeoutMs } : {}),
      ...(config.retrievalTimeoutMs !== null ? { retrievalTimeoutMs: config.retrievalTimeoutMs } : {}),
      minUploadBytes: config.minUploadBytes,
      maxUploadBytes: config.maxUploadBytes,
    });
  }
  return new FilecoinRawContentStore(client);
}

export { FilecoinRawContentStore } from './backend.js';
// Public read-side projection lives in `src/storage/filecoin-public-metadata.ts`
// so route + service consumers don't import providers/filecoin/* directly.
// The provider directory keeps the internal upload allowlist only.

/**
 * Synapse `metadata` accepts `Record<string, string>` only. Convert
 * any number/boolean values from the parsed `dataSetMetadata` to
 * their canonical string form so the SDK boundary stays
 * type-aligned with no silent truncation.
 */
function filecoinDataSetMetadataToStrings(
  metadata: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}
