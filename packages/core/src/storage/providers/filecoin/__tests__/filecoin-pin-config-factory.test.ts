/**
 * @file Config parser + factory-dispatch tests for the Phase 5
 * `RAW_STORAGE_FILECOIN_DRIVER=filecoin_pin` driver selector.
 *
 * The bounded instruction:
 *   - `parseFilecoinProviderConfig` must accept both `synapse`
 *     and `filecoin_pin`; reject anything else with a typed
 *     error message;
 *   - `createFilecoinStorageBackend` must dispatch to the
 *     filecoin-pin client when `config.driver === 'filecoin_pin'`
 *     and to the Synapse client otherwise.
 *
 * The factory cannot reach a real Synapse RPC from a unit test —
 * we satisfy `buildSynapse`'s vendor requirements just enough for
 * the construction call to return, then inspect `client.driver`
 * on the `FilecoinRawContentStore`'s internal handle via a
 * runtime peek. The Synapse SDK's `create()` call is mocked out
 * so no real network IO occurs.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseFilecoinProviderConfig } from '../config.js';
import type { FilecoinProviderConfig } from '../config.js';
import type { FilecoinProviderClient } from '../provider-client.js';

// Hoisted module mock — `Synapse.create` reaches the JSON-RPC; we
// replace `buildSynapse` with a stub so the factory can complete
// without a real calibration RPC. `vi.mock` is hoisted by vitest's
// transformer, so the call lives at module scope above any
// describe block.
vi.mock('../synapse-construction.js', () => ({
  buildSynapse: () => ({} as unknown),
}));

const FAKE_KEY = '0x' + 'a'.repeat(64);

function envBlock(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RAW_STORAGE_FILECOIN_DRIVER: 'synapse',
    RAW_STORAGE_FILECOIN_NETWORK: 'calibration',
    RAW_STORAGE_FILECOIN_PRIVATE_KEY: FAKE_KEY,
    RAW_STORAGE_FILECOIN_SOURCE: 'atomicmemory-test',
    RAW_STORAGE_FILECOIN_WITH_CDN: 'false',
    ...overrides,
  };
}

describe('parseFilecoinProviderConfig — driver acceptance/rejection', () => {
  it("accepts driver='synapse' (the default)", () => {
    const cfg = parseFilecoinProviderConfig(envBlock());
    expect(cfg.driver).toBe('synapse');
  });

  it("accepts driver='filecoin_pin' (Phase 5 opt-in)", () => {
    const cfg = parseFilecoinProviderConfig(envBlock({ RAW_STORAGE_FILECOIN_DRIVER: 'filecoin_pin' }));
    expect(cfg.driver).toBe('filecoin_pin');
  });

  it.each([
    ['<unset>', undefined],
    ['empty string', ''],
    ['unknown driver', 'foc'],
    ['typo', 'synapsey'],
    ['legacy hyphenated form', 'filecoin-pin'],
    ['uppercase', 'SYNAPSE'],
  ])('rejects %s with a sanitized message', (_label, value) => {
    const env = envBlock();
    if (value === undefined) delete env.RAW_STORAGE_FILECOIN_DRIVER;
    else env.RAW_STORAGE_FILECOIN_DRIVER = value;
    expect(() => parseFilecoinProviderConfig(env)).toThrow(
      /RAW_STORAGE_FILECOIN_DRIVER must equal 'synapse' or 'filecoin_pin'/,
    );
  });
});

describe('createFilecoinStorageBackend — driver dispatch', () => {
  async function buildAndExtractDriver(driver: 'synapse' | 'filecoin_pin'): Promise<string> {
    const config: FilecoinProviderConfig = {
      driver,
      network: 'calibration',
      privateKey: FAKE_KEY,
      source: 'atomicmemory-test',
      withCdn: false,
      providerIds: [],
      copies: null,
      dataSetMetadata: {},
      maxUploadBytes: null,
      minUploadBytes: null,
      uploadTimeoutMs: null,
      retrievalTimeoutMs: null,
    };
    const { createFilecoinStorageBackend } = await import('../index.js');
    const store = await createFilecoinStorageBackend(config);
    // `FilecoinRawContentStore.client` is private; the test
    // unwraps via a typed cast through `unknown` so we can
    // assert the dispatched driver without widening the
    // production API surface.
    const internal = store as unknown as { client: FilecoinProviderClient };
    return internal.client.driver;
  }

  it("driver='synapse' → SynapseFilecoinProviderClient (the default)", async () => {
    expect(await buildAndExtractDriver('synapse')).toBe('synapse');
  });

  it("driver='filecoin_pin' → FilecoinPinFilecoinProviderClient (Phase 5 opt-in)", async () => {
    expect(await buildAndExtractDriver('filecoin_pin')).toBe('filecoin_pin');
  });
});
