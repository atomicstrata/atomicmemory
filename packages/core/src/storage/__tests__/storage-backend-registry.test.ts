/**
 * Unit tests for `StorageBackendRegistry` — the direct-storage
 * parallel to `RawContentStoreRegistry`. Behaviour mirrors
 * `store-registry.test.ts`: lookup by provider, fail-loud on missing
 * adapters, refuse duplicate registrations.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBackendRegistry,
  singleBackendRegistry,
} from '../storage-backend-registry.js';
import type { StorageBackend } from '../storage-backend.js';

function makeBackend(provider: string): StorageBackend {
  return {
    provider,
    put: async () => ({
      uri: `${provider}://bytes`, sizeBytes: 0,
      plaintextHash: 'h', storedHash: 'h', providerMetadata: {},
    }),
    get: async () => ({ body: Buffer.alloc(0), contentType: null, sizeBytes: 0 }),
    head: async () => ({ exists: false, sizeBytes: null, contentType: null }),
    delete: async () => ({ deleted: true, semantics: 'deleted' }),
  };
}

describe('buildBackendRegistry', () => {
  it('registers the active backend under its provider id', () => {
    const active = makeBackend('local_fs');
    const reg = buildBackendRegistry(active);
    expect(reg.active).toBe(active);
    expect(reg.get('local_fs')).toBe(active);
    expect(reg.has('local_fs')).toBe(true);
  });

  it('returns undefined for unregistered providers (callers MUST fail loud)', () => {
    const reg = buildBackendRegistry(makeBackend('s3'));
    expect(reg.get('filecoin')).toBeUndefined();
    expect(reg.has('filecoin')).toBe(false);
  });

  it('registers legacy backends alongside the active backend', () => {
    const active = makeBackend('s3');
    const legacy = makeBackend('local_fs');
    const reg = buildBackendRegistry(active, [legacy]);
    expect(reg.get('s3')).toBe(active);
    expect(reg.get('local_fs')).toBe(legacy);
    expect(reg.entries.map(([p]) => p)).toEqual(['s3', 'local_fs']);
  });

  it('null active + empty legacy = pointer-only deployment', () => {
    const reg = buildBackendRegistry(null);
    expect(reg.active).toBeNull();
    expect(reg.entries).toEqual([]);
    expect(reg.has('local_fs')).toBe(false);
  });

  it('null active + legacy backends = empty active, populated legacy', () => {
    // Edge case: a future deployment with no managed writes but
    // historical legacy rows still needs to read/delete them. The
    // registry supports `active=null` plus a non-empty legacy list.
    const reg = buildBackendRegistry(null, [makeBackend('local_fs')]);
    expect(reg.active).toBeNull();
    expect(reg.get('local_fs')?.provider).toBe('local_fs');
  });

  it('throws when the same provider appears in both active and legacy', () => {
    expect(() =>
      buildBackendRegistry(makeBackend('s3'), [makeBackend('s3')]),
    ).toThrow(/registered twice/);
  });

  it('throws when two legacy entries share a provider', () => {
    expect(() =>
      buildBackendRegistry(null, [makeBackend('local_fs'), makeBackend('local_fs')]),
    ).toThrow(/registered twice/);
  });
});

describe('singleBackendRegistry', () => {
  it('wraps one backend with no legacy entries', () => {
    const backend = makeBackend('local_fs');
    const reg = singleBackendRegistry(backend);
    expect(reg.active).toBe(backend);
    expect(reg.entries.map(([p]) => p)).toEqual(['local_fs']);
  });

  it('accepts null for pointer-only test deployments', () => {
    const reg = singleBackendRegistry(null);
    expect(reg.active).toBeNull();
    expect(reg.entries).toEqual([]);
  });
});
