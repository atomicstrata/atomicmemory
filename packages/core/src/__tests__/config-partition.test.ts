/**
 * Phase 7 config-split partition test.
 *
 * Pins the partition of `RuntimeConfig` fields between the supported public
 * contract (`SUPPORTED_RUNTIME_CONFIG_FIELDS`) and the internal/experimental
 * policy surface (`INTERNAL_POLICY_CONFIG_FIELDS`). The two must be disjoint
 * and their union must cover every runtime field — otherwise the "supported
 * vs experimental" documentation drifts silently as new fields land.
 *
 * This is the Step 3a fence from the post-Phase-6 follow-on plan.
 */

import { describe, it, expect } from 'vitest';
import {
  config,
  SUPPORTED_RUNTIME_CONFIG_FIELDS,
  INTERNAL_POLICY_CONFIG_FIELDS,
} from '../config.js';

describe('runtime config partition', () => {
  const supported = new Set<string>(SUPPORTED_RUNTIME_CONFIG_FIELDS);
  const internal = new Set<string>(INTERNAL_POLICY_CONFIG_FIELDS);
  const runtimeFields = new Set(Object.keys(config));

  it('supported and internal partitions are disjoint', () => {
    const overlap = [...supported].filter((field) => internal.has(field));
    expect(overlap).toEqual([]);
  });

  it('union covers every RuntimeConfig field present on the singleton', () => {
    const missing = [...runtimeFields].filter(
      (field) => !supported.has(field) && !internal.has(field),
    );
    expect(missing).toEqual([]);
  });

  it('no partition field references a non-existent RuntimeConfig key', () => {
    const strays = [...supported, ...internal].filter(
      (field) => !runtimeFields.has(field),
    );
    expect(strays).toEqual([]);
  });

  it('exposes a stable count for review-time sanity', () => {
    expect(supported.size + internal.size).toBe(runtimeFields.size);
  });
});
