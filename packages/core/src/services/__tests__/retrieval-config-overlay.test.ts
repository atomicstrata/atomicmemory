/**
 * @file Unit tests for the per-request config overlay utility.
 *
 * Verifies the three primitives consumed by memory routes:
 *   - applyConfigOverride: shallow merge, unchanged base, overridden target
 *   - hashEffectiveConfig: deterministic under key reordering, sensitive
 *     to value changes, shape `sha256:<64-hex>`
 *   - summarizeOverrideKeys: sorted comma-joined key list
 */

import { describe, expect, it } from 'vitest';
import {
  applyConfigOverride,
  classifyOverrideKeys,
  hashEffectiveConfig,
  summarizeOverrideKeys,
} from '../retrieval-config-overlay.js';
import type { RuntimeConfig } from '../../config.js';

function makeConfig(partial: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    hybridSearchEnabled: false,
    mmrEnabled: true,
    mmrLambda: 0.5,
    maxSearchResults: 10,
    audnCandidateThreshold: 0.85,
    ...partial,
  } as RuntimeConfig;
}

describe('applyConfigOverride', () => {
  it('returns the base untouched when override is an empty object', () => {
    const base = makeConfig();
    const result = applyConfigOverride(base, {});
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  it('shallow-merges override fields on top of the base', () => {
    const base = makeConfig({ hybridSearchEnabled: false, mmrLambda: 0.5 });
    const result = applyConfigOverride(base, {
      hybridSearchEnabled: true,
      mmrLambda: 0.8,
    });
    expect(result.hybridSearchEnabled).toBe(true);
    expect(result.mmrLambda).toBe(0.8);
    expect(result.maxSearchResults).toBe(base.maxSearchResults);
  });

  it('does not mutate the base config', () => {
    const base = makeConfig({ hybridSearchEnabled: false });
    applyConfigOverride(base, { hybridSearchEnabled: true });
    expect(base.hybridSearchEnabled).toBe(false);
  });

  it('does not apply decode-cap overrides that LLM calls read from the singleton', () => {
    const base = makeConfig({
      extractionMaxTokens: 4096,
      audnMaxTokens: 2048,
      audnJsonSchema: false,
    });
    const result = applyConfigOverride(base, {
      extractionMaxTokens: 128,
      audnMaxTokens: 64,
      audnJsonSchema: true,
      hybridSearchEnabled: true,
    });
    expect(result.extractionMaxTokens).toBe(4096);
    expect(result.audnMaxTokens).toBe(2048);
    expect(result.audnJsonSchema).toBe(false);
    expect(result.hybridSearchEnabled).toBe(true);
  });
});

describe('hashEffectiveConfig', () => {
  it('returns a sha256:<hex> fingerprint', () => {
    const hash = hashEffectiveConfig(makeConfig());
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across insertion order of the same logical config', () => {
    const a = makeConfig({ hybridSearchEnabled: true, mmrLambda: 0.7 });
    const b = makeConfig({ mmrLambda: 0.7, hybridSearchEnabled: true });
    expect(hashEffectiveConfig(a)).toBe(hashEffectiveConfig(b));
  });

  it('changes when any field value changes', () => {
    const a = hashEffectiveConfig(makeConfig({ hybridSearchEnabled: false }));
    const b = hashEffectiveConfig(makeConfig({ hybridSearchEnabled: true }));
    expect(a).not.toBe(b);
  });
});

describe('classifyOverrideKeys', () => {
  const known = new Set(['hybridSearchEnabled', 'extractionMaxTokens', 'audnMaxTokens']);

  it('reports denylisted RuntimeConfig fields as ignored, not unknown', () => {
    expect(classifyOverrideKeys({ extractionMaxTokens: 128, audnMaxTokens: 64 }, known)).toEqual({
      applied: [],
      ignored: ['audnMaxTokens', 'extractionMaxTokens'],
      unknown: [],
    });
  });

  it('keeps applied keys separate from ignored and unknown', () => {
    expect(classifyOverrideKeys({
      hybridSearchEnabled: true,
      extractionMaxTokens: 128,
      futureFieldX: true,
    } as Partial<RuntimeConfig>, known)).toEqual({
      applied: ['futureFieldX', 'hybridSearchEnabled'],
      ignored: ['extractionMaxTokens'],
      unknown: ['futureFieldX'],
    });
  });
});

describe('summarizeOverrideKeys', () => {
  it('returns an empty string for an empty override', () => {
    expect(summarizeOverrideKeys({})).toBe('');
  });

  it('returns a single key for a single-field override', () => {
    expect(summarizeOverrideKeys({ hybridSearchEnabled: true })).toBe('hybridSearchEnabled');
  });

  it('returns keys sorted alphabetically regardless of insertion order', () => {
    const joined = summarizeOverrideKeys({
      mmrEnabled: true,
      hybridSearchEnabled: false,
      audnCandidateThreshold: 0.9,
    });
    expect(joined).toBe('audnCandidateThreshold,hybridSearchEnabled,mmrEnabled');
  });
});
