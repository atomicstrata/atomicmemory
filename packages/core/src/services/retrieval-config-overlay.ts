/**
 * @file Per-request config overlay primitives.
 *
 * Supports the `config_override` request-body field on memory ingest
 * and search routes. Three responsibilities:
 *
 *   1. `applyConfigOverride` — shallow-merge a validated flat override
 *      onto the startup `RuntimeConfig`. Because the override shape
 *      matches the flat `RuntimeConfig` field names one-for-one, this
 *      is a genuine single-line `{ ...base, ...override }` — no
 *      mapping layer, no nested traversal.
 *
 *   2. `hashEffectiveConfig` — stable SHA-256 over the effective config,
 *      serialized with deterministically-sorted keys, returned as
 *      `sha256:<hex>`. Emitted via the `X-Atomicmem-Effective-Config-Hash`
 *      response header so callers can link traces to a canonical config
 *      fingerprint.
 *
 *   3. `summarizeOverrideKeys` — comma-separated list of top-level keys
 *      present in the override object, for the
 *      `X-Atomicmem-Config-Override-Keys` header.
 *
 * Design reference: atomicmemory-research/docs/core-repo/design/
 * per-request-config-override.md §2.3, §2.5.
 */

import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';

/** Merge a validated override on top of the startup runtime config. */
export function applyConfigOverride(
  base: RuntimeConfig,
  override: Partial<RuntimeConfig>,
): RuntimeConfig {
  return { ...base, ...override };
}

/**
 * SHA-256 fingerprint of the effective config. Keys are sorted before
 * serialization so the hash is stable regardless of construction order.
 * Returned in the `sha256:<hex>` form emitted on the response header.
 */
export function hashEffectiveConfig(cfg: RuntimeConfig): string {
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

/** Comma-separated list of keys present in the override object. */
export function summarizeOverrideKeys(override: Partial<RuntimeConfig>): string {
  return Object.keys(override).sort().join(',');
}
