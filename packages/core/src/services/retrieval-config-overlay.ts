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
 *   3. `classifyOverrideKeys` — applied / ignored / unknown split for
 *      `X-Atomicmem-Config-Override-Keys`,
 *      `X-Atomicmem-Ignored-Override-Keys`, and
 *      `X-Atomicmem-Unknown-Override-Keys`.
 *
 * Public contract: request overrides are validated before this helper sees
 * them, so the merge step remains intentionally shallow and deterministic.
 */

import { createHash } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';

/**
 * Decode caps and AUDN wire format are read from the process singleton.
 * Accepting them on config_override would report "applied" while doing nothing.
 */
const REQUEST_SINGLETON_ONLY_CONFIG_KEYS = new Set([
  'extractionMaxTokens',
  'audnMaxTokens',
  'audnJsonSchema',
]);

/** Applied / ignored / unknown classification for override response headers. */
export function classifyOverrideKeys(
  override: Partial<RuntimeConfig>,
  knownKeys: ReadonlySet<string>,
): { applied: string[]; ignored: string[]; unknown: string[] } {
  const ignored = nonOverridableOverrideKeys(override);
  const ignoredSet = new Set(ignored);
  const submitted = Object.keys(override);
  return {
    applied: submitted.filter((key) => !ignoredSet.has(key)).sort(),
    ignored,
    unknown: submitted.filter((key) => !knownKeys.has(key)).sort(),
  };
}

/** Override keys that cannot take effect on the current request path. */
function nonOverridableOverrideKeys(override: Partial<RuntimeConfig>): string[] {
  return Object.keys(override)
    .filter((key) => REQUEST_SINGLETON_ONLY_CONFIG_KEYS.has(key))
    .sort();
}

/** Merge a validated override on top of the startup runtime config. */
export function applyConfigOverride(
  base: RuntimeConfig,
  override: Partial<RuntimeConfig>,
): RuntimeConfig {
  const applied = { ...override };
  for (const key of REQUEST_SINGLETON_ONLY_CONFIG_KEYS) {
    delete applied[key as keyof RuntimeConfig];
  }
  return { ...base, ...applied };
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
