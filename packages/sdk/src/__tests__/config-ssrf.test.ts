/**
 * @file SSRF-guard coverage for every SDK surface that accepts `apiUrl`.
 *
 * Each provider/client constructor must reject the AWS IMDS link-local
 * endpoint (and its numeric-encoded bypass) regardless of the
 * `allowPrivateNetworks` opt-in, and — when strict — gate private/loopback
 * literals. Mirrors the python SDK's `test_config_ssrf.py` enumeration.
 *
 * TypeScript interfaces are erased at runtime, so the behavioral surface
 * list (`SURFACES`) is hand-maintained. A deterministic source scan
 * (`test the source declares the guard on every apiUrl config`) backs it:
 * it reads the SDK source and fails when any public `apiUrl` config omits
 * the `allowPrivateNetworks` guard, or when the number of guarded configs
 * drifts from `SURFACES` — so a newly added config cannot quietly skip the
 * chokepoint (AGNT-001 follow-up).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { AtomicMemoryClient } from '../client/atomic-memory-client.js';
import { AtomicMemoryProvider } from '../memory/atomicmemory-provider/index.js';
import { HindsightProvider } from '../memory/hindsight-provider/index.js';
import { Mem0Provider } from '../memory/mem0-provider/index.js';
import { ConcreteStorageClient } from '../storage/index.js';
import { EntitiesClient } from '../entities/index.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Internal transport types that carry an `apiUrl` *after* a config surface
 * has already validated it (they never construct from raw caller input), so
 * they are intentionally exempt from declaring the `allowPrivateNetworks`
 * guard. Adding a new entry here must be a conscious, reviewed decision.
 */
const VALIDATED_DOWNSTREAM_CARRIERS = ['memory/shared/http-client.ts'];

/** All `.ts` source files (excluding tests) under the SDK src root. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Source files that declare an `apiUrl: string` config/transport field. */
function filesDeclaringApiUrlField(): string[] {
  return sourceFiles(SRC_ROOT)
    .filter((file) => /apiUrl: string/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC_ROOT, file));
}

const IMDS = 'http://169.254.169.254/latest/meta-data/';
const IMDS_DECIMAL = 'http://2852039166/latest/meta-data/';
const LOOPBACK = 'http://127.0.0.1:17350';

/** Every constructor that takes an `apiUrl`, built from a candidate URL + opts. */
const SURFACES: ReadonlyArray<{
  name: string;
  build: (apiUrl: string, opts?: { allowPrivateNetworks?: boolean }) => unknown;
}> = [
  { name: 'AtomicMemoryClient', build: (u, o) => new AtomicMemoryClient({ apiUrl: u, apiKey: 's', userId: 'u', ...o }) },
  { name: 'AtomicMemoryProvider', build: (u, o) => new AtomicMemoryProvider({ apiUrl: u, ...o }) },
  { name: 'HindsightProvider', build: (u, o) => new HindsightProvider({ apiUrl: u, ...o }) },
  { name: 'Mem0Provider', build: (u, o) => new Mem0Provider({ apiUrl: u, ...o }) },
  { name: 'ConcreteStorageClient', build: (u, o) => new ConcreteStorageClient({ apiUrl: u, apiKey: 's', userId: 'u', ...o }) },
  { name: 'EntitiesClient', build: (u, o) => new EntitiesClient({ apiUrl: u, apiKey: 's', ...o }) },
];

describe('config SSRF guard (every apiUrl surface)', () => {
  it('enumerates at least the six known apiUrl surfaces', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(6);
  });

  it('source declares the allowPrivateNetworks guard on every public apiUrl config', () => {
    const unguarded = filesDeclaringApiUrlField().filter(
      (file) =>
        !VALIDATED_DOWNSTREAM_CARRIERS.includes(file) &&
        !/allowPrivateNetworks/.test(readFileSync(join(SRC_ROOT, file), 'utf8')),
    );
    // A new apiUrl config that forgets the guard lands here. Wire it through
    // validateApiUrl (or, if it's validated-downstream transport, allowlist it).
    expect(unguarded, `apiUrl configs missing the SSRF guard: ${unguarded.join(', ')}`).toEqual([]);
  });

  it('guarded apiUrl configs in source match the enumerated SURFACES count', () => {
    const guardedConfigs = filesDeclaringApiUrlField().filter(
      (file) => !VALIDATED_DOWNSTREAM_CARRIERS.includes(file),
    );
    // Drift here means a config was added/removed in source but SURFACES (the
    // behavioral coverage above) was not updated to match.
    expect(guardedConfigs.length, `source apiUrl configs: ${guardedConfigs.join(', ')}`).toBe(
      SURFACES.length,
    );
  });

  it('every surface blocks the IMDS endpoint, even with private networks allowed', () => {
    for (const { name, build } of SURFACES) {
      expect(() => build(IMDS), name).toThrow();
      expect(() => build(IMDS, { allowPrivateNetworks: true }), `${name} (decimal)`).toThrow();
      expect(() => build(IMDS_DECIMAL, { allowPrivateNetworks: true }), `${name} (decimal)`).toThrow();
    }
  });

  it('every surface allows loopback by default (posture B) and blocks it when strict', () => {
    for (const { name, build } of SURFACES) {
      expect(() => build(LOOPBACK), name).not.toThrow();
      expect(() => build(LOOPBACK, { allowPrivateNetworks: false }), `${name} (strict)`).toThrow();
    }
  });
});
