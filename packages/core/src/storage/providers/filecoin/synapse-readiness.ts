/**
 * @file Real Synapse-backed readiness probes.
 *
 * Lives in its own module to keep `synapse-client.ts` under the
 * workspace 400-LOC cap. Exports `synapseCheckReadiness(synapse,
 * options, network)` which runs the non-mutating probes
 * documented in `FILECOIN_READINESS_REQUIRED_CHECKS` and returns
 * the closed-shape check list `FilecoinProviderClient.checkReadiness`
 * promises.
 *
 * All probes are non-mutating SDK reads:
 *   - `storage.getStorageInfo()`  — pricing / providers / allowances / service bounds
 *   - `storage.getUploadCosts()`  — canonical "ready to upload at this size" probe
 *   - `storage.findDataSets()`    — owned data-set inventory (no creation)
 *   - `client.getChainId()`       — connected-chain id
 *
 * Sanitization rule: NO call inside this module ever lets a wallet
 * address, balance numeric, allowance numeric, provider auth payload,
 * or raw vendor error message escape. Every check carries a stable
 * `errorCode` from the closed set documented inline below.
 */

import { calibration, mainnet } from '@filoz/synapse-sdk';
import type {
  FilecoinReadinessCheck,
  FilecoinReadinessNetwork,
} from './provider-client.js';
import type {
  SynapseLike,
  SynapseStorageInfoLike,
} from './synapse-client.js';

/**
 * Closed enum of error codes emitted by readiness checks. Mirrors
 * the names callers (reconciler, document upload preflight)
 * can switch on without ever inspecting message strings.
 */
type ReadinessErrorCode =
  // True not-yet-implemented state.
  | 'not_implemented'
  // Cascade markers — a more-fundamental check failed first and
  // dependent checks could not be evaluated.
  | 'blocked_by_network_unreachable'
  // Per-check failure codes.
  | 'network_unreachable'
  | 'chain_mismatch'
  | 'payment_allowance_not_configured'
  | 'payment_allowance_not_approved'
  | 'payment_rate_allowance_exhausted'
  | 'payment_lockup_allowance_exhausted'
  | 'payment_min_upload_cost_insufficient'
  | 'provider_id_not_listed'
  | 'no_providers_listed'
  | 'data_set_not_yet_created'
  | 'max_upload_exceeds_service'
  | 'min_upload_below_service'
  | 'upload_size_bounds_invalid';

export interface ReadinessProbeOptions {
  readonly providerIds: ReadonlyArray<string>;
  readonly minUploadBytes: number | null;
  readonly maxUploadBytes: number | null;
  readonly withCdn?: boolean;
}

interface FetchStorageInfoOutcome {
  readonly info: SynapseStorageInfoLike | null;
  readonly errorCode: ReadinessErrorCode | null;
}

/**
 * Run the documented Synapse readiness probes. Returns the closed-
 * shape check list in `FILECOIN_READINESS_REQUIRED_CHECKS` order.
 * All calls are non-mutating: `getStorageInfo()`,
 * `getUploadCosts()`, `findDataSets()`, `client.getChainId()`. No
 * upload, no data-set creation, no payment side-effects.
 */
export async function synapseCheckReadiness(
  synapse: SynapseLike,
  options: ReadinessProbeOptions,
  network: FilecoinReadinessNetwork,
): Promise<ReadonlyArray<FilecoinReadinessCheck>> {
  const storage = await fetchStorageInfo(synapse);
  const chain = await chainCheck(synapse, network, storage.errorCode);
  const payment = await paymentCheck(synapse, options, storage);
  const dataSet = await dataSetCheck(synapse, storage.errorCode);
  return [
    networkReachableCheck(storage.errorCode),
    keyLoadableCheck(),
    chain,
    payment,
    providerIdsCheck(options.providerIds, storage.info, storage.errorCode),
    dataSet,
    retrievalAvailableCheck(),
    uploadSizeBoundsCheck(options, storage.info, storage.errorCode),
  ];
}

async function fetchStorageInfo(synapse: SynapseLike): Promise<FetchStorageInfoOutcome> {
  try {
    const info = await synapse.storage.getStorageInfo();
    return { info, errorCode: null };
  } catch {
    return { info: null, errorCode: 'network_unreachable' };
  }
}

async function chainCheck(
  synapse: SynapseLike,
  network: FilecoinReadinessNetwork,
  storageError: ReadinessErrorCode | null,
): Promise<FilecoinReadinessCheck> {
  if (storageError !== null) return blockedByNetwork('account_on_expected_network');
  const expected = expectedChainIdFor(network);
  let actual: bigint | number;
  try {
    actual = await synapse.client.getChainId();
  } catch {
    return failed('account_on_expected_network', 'network_unreachable');
  }
  if (BigInt(actual) === expected) return passed('account_on_expected_network');
  return failed('account_on_expected_network', 'chain_mismatch');
}

/**
 * Map the AtomicMemory readiness network to the canonical Synapse
 * chain id. The SDK exports the chain objects directly; importing
 * them here means a future SDK that re-numbers calibration or
 * adds a new network surfaces at the boundary, not silently.
 */
function expectedChainIdFor(network: FilecoinReadinessNetwork): bigint {
  switch (network) {
    case 'calibration':
      return BigInt(calibration.id);
    case 'mainnet':
      return BigInt(mainnet.id);
  }
}

async function dataSetCheck(
  synapse: SynapseLike,
  storageError: ReadinessErrorCode | null,
): Promise<FilecoinReadinessCheck> {
  if (storageError !== null) return blockedByNetwork('data_set_available');
  try {
    const sets = await synapse.storage.findDataSets();
    if (sets.length === 0) {
      // Cold-start state — first upload creates one. Reported as
      // `'unknown'` rather than `'failed'` because the absence is
      // expected before any upload.
      return {
        name: 'data_set_available',
        status: 'unknown',
        errorCode: 'data_set_not_yet_created',
      };
    }
    return passed('data_set_available');
  } catch {
    return failed('data_set_available', 'network_unreachable');
  }
}

function networkReachableCheck(storageError: ReadinessErrorCode | null): FilecoinReadinessCheck {
  if (storageError === null) return passed('network_reachable');
  return failed('network_reachable', storageError);
}

function keyLoadableCheck(): FilecoinReadinessCheck {
  // The Synapse instance was constructed via `buildSynapse`, which
  // calls `viem/accounts.privateKeyToAccount`. Reaching this code
  // implies the key syntactically loaded; readiness reports the
  // check as `'passed'` rather than re-probing the key material.
  return passed('key_loadable');
}

/**
 * Payment readiness in three layers:
 *   1. If `getStorageInfo` failed upstream, cascade to
 *      `blocked_by_network_unreachable`.
 *   2. Use the cheap `allowances` snapshot to detect obvious
 *      mis-configuration (null / not approved / exhausted) — fail
 *      fast with a precise code.
 *   3. If the snapshot looks OK, issue `getUploadCosts(minUploadSize)`
 *      as the canonical "are you ready for a min-size upload"
 *      probe. `result.ready === true` → passed;
 *      `result.ready === false` →
 *      `payment_min_upload_cost_insufficient`; throw →
 *      `blocked_by_network_unreachable`. NEVER returns passed
 *      without the SDK affirming `ready`.
 */
async function paymentCheck(
  synapse: SynapseLike,
  options: ReadinessProbeOptions,
  storage: FetchStorageInfoOutcome,
): Promise<FilecoinReadinessCheck> {
  if (storage.errorCode !== null) return blockedByNetwork('payment_covers_minimum_upload');
  const info = storage.info;
  if (info === null || info.allowances === null) {
    return failed('payment_covers_minimum_upload', 'payment_allowance_not_configured');
  }
  const a = info.allowances;
  if (!a.isApproved) return failed('payment_covers_minimum_upload', 'payment_allowance_not_approved');
  if (a.rateAllowance <= a.rateUsed) {
    return failed('payment_covers_minimum_upload', 'payment_rate_allowance_exhausted');
  }
  if (a.lockupAllowance <= a.lockupUsed) {
    return failed('payment_covers_minimum_upload', 'payment_lockup_allowance_exhausted');
  }
  return probeMinUploadCost(synapse, info, options);
}

async function probeMinUploadCost(
  synapse: SynapseLike,
  info: SynapseStorageInfoLike,
  options: ReadinessProbeOptions,
): Promise<FilecoinReadinessCheck> {
  const dataSize = BigInt(info.serviceParameters.minUploadSize);
  let costs: { readonly ready: boolean };
  try {
    costs = await synapse.storage.getUploadCosts({
      dataSize,
      ...(options.withCdn !== undefined ? { withCDN: options.withCdn } : {}),
    });
  } catch {
    return blockedByNetwork('payment_covers_minimum_upload');
  }
  if (costs.ready) return passed('payment_covers_minimum_upload');
  return failed('payment_covers_minimum_upload', 'payment_min_upload_cost_insufficient');
}

function providerIdsCheck(
  configured: ReadonlyArray<string>,
  info: SynapseStorageInfoLike | null,
  storageError: ReadinessErrorCode | null,
): FilecoinReadinessCheck {
  if (storageError !== null) return blockedByNetwork('provider_ids_reachable');
  // If no operator-pinned providers, the SDK picks at upload time;
  // we only verify the SDK saw at least one provider.
  if (configured.length === 0) {
    if (info && info.providers.length === 0) {
      return failed('provider_ids_reachable', 'no_providers_listed');
    }
    return passed('provider_ids_reachable');
  }
  if (info === null) return blockedByNetwork('provider_ids_reachable');
  const listed = new Set(info.providers.map((p) => p.id.toString()));
  for (const id of configured) {
    if (!listed.has(id)) return failed('provider_ids_reachable', 'provider_id_not_listed');
  }
  return passed('provider_ids_reachable');
}

function retrievalAvailableCheck(): FilecoinReadinessCheck {
  // No non-mutating retrieval primitive exposed on `StorageManager`
  // in this SDK release: `pieceStatus` is per-context, and the cheap
  // "is the SDK retrieval path healthy" question has no SDK answer.
  // Reported as
  // `'unknown' / 'not_implemented'` (truly not yet implemented) so
  // operators can distinguish this from cascade-blocked checks.
  return notImplemented('retrieval_available');
}

function uploadSizeBoundsCheck(
  options: ReadinessProbeOptions,
  info: SynapseStorageInfoLike | null,
  storageError: ReadinessErrorCode | null,
): FilecoinReadinessCheck {
  if (storageError !== null) return blockedByNetwork('upload_size_bounds_compatible');
  if (info === null) return blockedByNetwork('upload_size_bounds_compatible');
  const svcMin = info.serviceParameters.minUploadSize;
  const svcMax = info.serviceParameters.maxUploadSize;
  if (svcMin > svcMax) {
    return failed('upload_size_bounds_compatible', 'upload_size_bounds_invalid');
  }
  if (options.maxUploadBytes !== null && options.maxUploadBytes > svcMax) {
    return failed('upload_size_bounds_compatible', 'max_upload_exceeds_service');
  }
  if (options.minUploadBytes !== null && options.minUploadBytes < svcMin) {
    return failed('upload_size_bounds_compatible', 'min_upload_below_service');
  }
  return passed('upload_size_bounds_compatible');
}

function passed(name: string): FilecoinReadinessCheck {
  return { name, status: 'passed' };
}

function failed(name: string, errorCode: ReadinessErrorCode): FilecoinReadinessCheck {
  return { name, status: 'failed', errorCode };
}

/**
 * Unknown because a more-fundamental upstream check failed (almost
 * always `network_reachable`). Distinguished from `notImplemented`
 * via the `blocked_by_network_unreachable` code so operators see
 * "this couldn't be evaluated, not 'we haven't built it yet'".
 */
function blockedByNetwork(name: string): FilecoinReadinessCheck {
  return { name, status: 'unknown', errorCode: 'blocked_by_network_unreachable' };
}

/** Unknown because the check itself is not wired yet. */
function notImplemented(name: string): FilecoinReadinessCheck {
  return { name, status: 'unknown', errorCode: 'not_implemented' };
}
