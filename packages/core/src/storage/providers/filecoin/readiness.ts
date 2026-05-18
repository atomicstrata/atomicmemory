/**
 * @file Filecoin readiness — INTERNAL-only.
 *
 * The check types (`FilecoinReadinessCheck`,
 * `FilecoinReadinessStatus`, `FilecoinReadinessNetwork`) live on
 * `provider-client.ts` because they are part of the
 * `FilecoinProviderClient.checkReadiness` boundary. This module
 * carries:
 *
 *   - `FilecoinReadiness` — the aggregate shape consumers see.
 *   - `aggregateFilecoinReadiness` — pure aggregator (closed,
 *     fail-closed on empty input).
 *   - `checkFilecoinReadiness(client, network)` — thin wrapper
 *     that delegates to `client.checkReadiness(network)` and
 *     builds the aggregate.
 *   - `FILECOIN_READINESS_REQUIRED_CHECKS` — documented required
 *     probe names.
 *
 * The aggregate is INTERNAL to `src/storage/providers/filecoin/`
 * in v1. It is NOT exposed on any public HTTP route, NOT
 * projected into the SDK, and NOT included in the OpenAPI schema.
 * The factory exposes the helper so the document-upload pipeline
 * and (later) the reconciler can gate work on a successful probe
 * without re-implementing the SDK contract.
 *
 * Sanitization rule: the readiness object NEVER carries wallet
 * addresses, balances, allowances, provider auth payloads, or
 * raw vendor messages. The only public fields are the check
 * `name`, status enum, and an opaque `errorCode` string from the
 * closed set documented at the bottom of this file.
 */

import type {
  FilecoinDriverName,
  FilecoinProviderClient,
  FilecoinReadinessCheck,
  FilecoinReadinessNetwork,
} from './provider-client.js';

export type {
  FilecoinDriverName,
  FilecoinReadinessCheck,
  FilecoinReadinessNetwork,
  FilecoinReadinessStatus,
} from './provider-client.js';

export interface FilecoinReadiness {
  readonly provider: 'filecoin';
  readonly driver: FilecoinDriverName;
  readonly network: FilecoinReadinessNetwork;
  readonly ready: boolean;
  readonly checks: ReadonlyArray<FilecoinReadinessCheck>;
}

/**
 * Documented required-check names. Callers may treat any
 * name not in this list as advisory; everything in it must be
 * `'passed'` for `ready === true`.
 */
export const FILECOIN_READINESS_REQUIRED_CHECKS = [
  'network_reachable',
  'key_loadable',
  'account_on_expected_network',
  'payment_covers_minimum_upload',
  'provider_ids_reachable',
  'data_set_available',
  'retrieval_available',
  'upload_size_bounds_compatible',
] as const;

/**
 * Pure aggregator: `ready === true` iff (1) the supplied checks
 * list is non-empty AND (2) every supplied check has
 * `status === 'passed'`. An empty list fails CLOSED — a future
 * wiring bug that hands this function an empty array must NOT
 * mark Filecoin ready.
 */
export function aggregateFilecoinReadiness(
  checks: ReadonlyArray<FilecoinReadinessCheck>,
): boolean {
  if (checks.length === 0) return false;
  for (const check of checks) {
    if (check.status !== 'passed') return false;
  }
  return true;
}

/**
 * Delegate to the underlying provider client's
 * `checkReadiness(network)` probe and wrap the result in the
 * documented aggregate shape. The test client returns all-
 * `'unknown'` checks; the real Synapse client issues
 * non-mutating SDK reads.
 */
export async function checkFilecoinReadiness(
  client: FilecoinProviderClient,
  network: FilecoinReadinessNetwork,
): Promise<FilecoinReadiness> {
  const checks = await client.checkReadiness(network);
  // `driver` reflects the boundary's actual driver — never a
  // hardcoded literal. Production: the live Synapse client →
  // `'synapse'`. Tests / a future filecoin-pin client → that
  // driver's literal. Hardcoding here would lie for non-Synapse
  // implementations and undermine the driver-agnostic invariant
  // the harvest plan establishes.
  return {
    provider: 'filecoin',
    driver: client.driver,
    network,
    ready: aggregateFilecoinReadiness(checks),
    checks,
  };
}
