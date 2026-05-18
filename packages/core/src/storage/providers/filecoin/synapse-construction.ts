/**
 * @file Construct a `Synapse` instance from a parsed
 * `FilecoinProviderConfig`. Owns the viem-account + chain wiring
 * so the rest of the provider module can stay vendor-agnostic.
 *
 * Boundary rule: this is the ONE place that imports
 * `@filoz/synapse-sdk` / `@filoz/synapse-core/chains` / `viem`.
 * Other provider files depend on the constructed `Synapse`
 * instance via `synapse-client.ts`, not on these packages.
 *
 * Construction is synchronous — `Synapse.create` does not perform
 * network I/O until the first `storage.upload` / `storage.download`
 * / readiness call. Tests inject a fake `Synapse`-shaped object
 * directly into `SynapseFilecoinProviderClient`; the production
 * factory path runs through this module.
 */

import { Synapse, calibration, mainnet } from '@filoz/synapse-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { FilecoinProviderError } from './errors.js';
import type { FilecoinProviderConfig } from './config.js';

/**
 * Build a `Synapse` instance from validated provider config.
 * Wraps account / chain construction in `FilecoinProviderError`
 * so the boundary stays clean even when viem rejects the key
 * (which `parseFilecoinPrivateKey` already syntactically blocked,
 * but defense-in-depth costs nothing).
 */
export function buildSynapse(config: FilecoinProviderConfig): Synapse {
  const account = toAccount(config.privateKey);
  const chain = config.network === 'mainnet' ? mainnet : calibration;
  return Synapse.create({
    account,
    chain,
    source: config.source,
    withCDN: config.withCdn,
  });
}

function toAccount(privateKeyHex: string): ReturnType<typeof privateKeyToAccount> {
  try {
    return privateKeyToAccount(privateKeyHex as Hex);
  } catch {
    // `parseFilecoinPrivateKey` already enforces `^0x[a-fA-F0-9]{64}$`
    // at config-load time. If viem still rejects, surface as a
    // sanitized provider error — NEVER include the key value.
    throw new FilecoinProviderError(
      'filecoin_invalid_private_key',
      'RAW_STORAGE_FILECOIN_PRIVATE_KEY failed account derivation.',
    );
  }
}
