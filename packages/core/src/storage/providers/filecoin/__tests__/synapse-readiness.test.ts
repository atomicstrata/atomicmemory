/**
 * @file Unit tests for the real Synapse-backed readiness probes.
 *
 * Tests run against an in-process fake `SynapseLike` exposing the
 * narrow `getStorageInfo` / `getUploadCosts` / `findDataSets` /
 * `client.getChainId` surface. The real SDK is never invoked; no
 * timing-based assertions.
 *
 * Chain-id mapping: this file pins the expected ids directly
 * (calibration=314159, mainnet=314) to surface any future SDK
 * re-numbering at the test boundary rather than silently tracking
 * the import.
 */

import { describe, expect, it, vi } from 'vitest';
import { synapseCheckReadiness, type ReadinessProbeOptions } from '../synapse-readiness.js';
import type {
  SynapseLike,
  SynapseStorageInfoLike,
  SynapseStorageLike,
} from '../synapse-client.js';
import {
  aggregateFilecoinReadiness,
  checkFilecoinReadiness,
  FILECOIN_READINESS_REQUIRED_CHECKS,
} from '../readiness.js';
import { SynapseFilecoinProviderClient } from '../synapse-client.js';

const CALIBRATION_CHAIN_ID = 314_159;
const MAINNET_CHAIN_ID = 314;

function fakeStorageInfo(overrides: Partial<SynapseStorageInfoLike> = {}): SynapseStorageInfoLike {
  return {
    providers: [{ id: 1n }, { id: 2n }],
    serviceParameters: { minUploadSize: 127, maxUploadSize: 1_065_353_216 },
    allowances: {
      isApproved: true,
      rateAllowance: 1_000_000n,
      rateUsed: 0n,
      lockupAllowance: 5_000_000n,
      lockupUsed: 0n,
    },
    ...overrides,
  };
}

interface FakeSetup {
  readonly info?: SynapseStorageInfoLike | Error;
  readonly dataSets?: ReadonlyArray<{ readonly dataSetId: bigint; readonly providerId: bigint }>;
  readonly dataSetsError?: unknown;
  readonly chainId?: number | bigint;
  readonly chainIdError?: unknown;
  readonly uploadCostsReady?: boolean;
  readonly uploadCostsError?: unknown;
}

function buildFake(setup: FakeSetup): SynapseLike {
  const getStorageInfo = vi.fn(async () => {
    if (setup.info instanceof Error) throw setup.info;
    return setup.info ?? fakeStorageInfo();
  });
  const findDataSets = vi.fn(async () => {
    if (setup.dataSetsError !== undefined) throw setup.dataSetsError;
    return setup.dataSets ?? [];
  });
  const getChainId = vi.fn(async () => {
    if (setup.chainIdError !== undefined) throw setup.chainIdError;
    return setup.chainId ?? CALIBRATION_CHAIN_ID;
  });
  const getUploadCosts = vi.fn(async (): Promise<{ readonly ready: boolean }> => {
    if (setup.uploadCostsError !== undefined) throw setup.uploadCostsError;
    return { ready: setup.uploadCostsReady ?? true };
  });
  const storage: SynapseStorageLike = {
    upload: vi.fn(async () => { throw new Error('not used'); }) as unknown as SynapseStorageLike['upload'],
    download: vi.fn(async () => { throw new Error('not used'); }) as unknown as SynapseStorageLike['download'],
    createContext: vi.fn(async () => { throw new Error('not used'); }) as unknown as SynapseStorageLike['createContext'],
    findDataSets: findDataSets as unknown as SynapseStorageLike['findDataSets'],
    getStorageInfo: getStorageInfo as unknown as SynapseStorageLike['getStorageInfo'],
    getUploadCosts: getUploadCosts as unknown as SynapseStorageLike['getUploadCosts'],
  };
  return {
    storage,
    chain: { id: CALIBRATION_CHAIN_ID },
    client: { getChainId },
  };
}

const NO_BOUNDS: ReadinessProbeOptions = {
  providerIds: [],
  minUploadBytes: null,
  maxUploadBytes: null,
};

function byName<T extends { name: string }>(checks: ReadonlyArray<T>): Record<string, T> {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

describe('synapseCheckReadiness — happy path', () => {
  async function happyChecks(): Promise<Record<string, { status: string; errorCode?: string }>> {
    const fake = buildFake({
      info: fakeStorageInfo(),
      dataSets: [{ dataSetId: 42n, providerId: 1n }],
    });
    return byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
  }

  it.each([
    'network_reachable',
    'key_loadable',
    'account_on_expected_network',
    'payment_covers_minimum_upload',
    'provider_ids_reachable',
    'data_set_available',
    'upload_size_bounds_compatible',
  ])('reports passed on %s when the SDK is healthy', async (name) => {
    const m = await happyChecks();
    expect(m[name]?.status).toBe('passed');
  });

  it('retrieval_available stays unknown / not_implemented until a retrieval probe is available', async () => {
    const m = await happyChecks();
    expect(m['retrieval_available']?.status).toBe('unknown');
    expect(m['retrieval_available']?.errorCode).toBe('not_implemented');
  });

  it('returns the documented required check names in order', async () => {
    const fake = buildFake({});
    const checks = await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration');
    expect(checks.map((c) => c.name)).toEqual([...FILECOIN_READINESS_REQUIRED_CHECKS]);
  });
});

describe('synapseCheckReadiness — network unreachable cascade', () => {
  it('failed network → dependent checks unknown with blocked_by_network_unreachable', async () => {
    const fake = buildFake({ info: new Error('eth_call timeout 12.34.56.78') });
    const checks = await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration');
    const m = byName(checks);
    expect(m['network_reachable']).toEqual({
      name: 'network_reachable',
      status: 'failed',
      errorCode: 'network_unreachable',
    });
    for (const name of [
      'account_on_expected_network',
      'payment_covers_minimum_upload',
      'provider_ids_reachable',
      'data_set_available',
      'upload_size_bounds_compatible',
    ]) {
      expect(m[name]?.status).toBe('unknown');
      expect(m[name]?.errorCode).toBe('blocked_by_network_unreachable');
    }
    // Cascade uses a distinct code from `not_implemented` so
    // operators can tell "blocked" from "not yet built".
    expect(m['retrieval_available']?.errorCode).toBe('not_implemented');
    // Vendor error message MUST NOT cross the boundary.
    expect(JSON.stringify(checks)).not.toContain('eth_call');
    expect(JSON.stringify(checks)).not.toContain('12.34.56.78');
  });
});

describe('synapseCheckReadiness — chain id is derived from requested network', () => {
  async function chainCheckFor(
    network: 'calibration' | 'mainnet',
    chainId: number,
  ): Promise<{ status: string; errorCode?: string }> {
    const fake = buildFake({ chainId });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, network));
    return m['account_on_expected_network']!;
  }

  it('calibration network + chainId=314_159 → passed', async () => {
    expect((await chainCheckFor('calibration', CALIBRATION_CHAIN_ID)).status).toBe('passed');
  });

  it('mainnet network + chainId=314 → passed', async () => {
    expect((await chainCheckFor('mainnet', MAINNET_CHAIN_ID)).status).toBe('passed');
  });

  it('calibration network + chainId=314 (mainnet) → failed/chain_mismatch', async () => {
    const r = await chainCheckFor('calibration', MAINNET_CHAIN_ID);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('chain_mismatch');
  });

  it('mainnet network + chainId=314_159 (calibration) → failed/chain_mismatch', async () => {
    const r = await chainCheckFor('mainnet', CALIBRATION_CHAIN_ID);
    expect(r.status).toBe('failed');
    expect(r.errorCode).toBe('chain_mismatch');
  });

  it('getChainId throwing → failed/network_unreachable (sanitized)', async () => {
    const fake = buildFake({ chainIdError: new Error('connection refused 10.0.0.1') });
    const checks = await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration');
    const m = byName(checks);
    expect(m['account_on_expected_network']?.status).toBe('failed');
    expect(m['account_on_expected_network']?.errorCode).toBe('network_unreachable');
    expect(JSON.stringify(checks)).not.toContain('10.0.0.1');
  });
});

describe('synapseCheckReadiness — payment / allowance branches', () => {
  it('fails with payment_allowance_not_configured when allowances is null', async () => {
    const fake = buildFake({ info: fakeStorageInfo({ allowances: null }) });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.status).toBe('failed');
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe('payment_allowance_not_configured');
  });

  it('fails with payment_allowance_not_approved when isApproved=false', async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        allowances: {
          isApproved: false,
          rateAllowance: 1n,
          rateUsed: 0n,
          lockupAllowance: 1n,
          lockupUsed: 0n,
        },
      }),
    });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe('payment_allowance_not_approved');
  });

  it('fails with payment_rate_allowance_exhausted when rateAllowance <= rateUsed', async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        allowances: {
          isApproved: true,
          rateAllowance: 100n,
          rateUsed: 100n,
          lockupAllowance: 1_000n,
          lockupUsed: 0n,
        },
      }),
    });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe('payment_rate_allowance_exhausted');
  });

  it('fails with payment_lockup_allowance_exhausted when lockupAllowance <= lockupUsed', async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        allowances: {
          isApproved: true,
          rateAllowance: 1_000n,
          rateUsed: 0n,
          lockupAllowance: 100n,
          lockupUsed: 100n,
        },
      }),
    });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe(
      'payment_lockup_allowance_exhausted',
    );
  });

  it('passed only when allowances are healthy AND getUploadCosts confirms ready=true', async () => {
    const fake = buildFake({ uploadCostsReady: true });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.status).toBe('passed');
  });

  it('fails with payment_min_upload_cost_insufficient when getUploadCosts returns ready=false', async () => {
    const fake = buildFake({ uploadCostsReady: false });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['payment_covers_minimum_upload']?.status).toBe('failed');
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe(
      'payment_min_upload_cost_insufficient',
    );
  });

  it('unknown / blocked_by_network_unreachable when getUploadCosts itself throws', async () => {
    const fake = buildFake({ uploadCostsError: new Error('rpc 503 wallet 0xdeadbeef') });
    const checks = await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration');
    const m = byName(checks);
    expect(m['payment_covers_minimum_upload']?.status).toBe('unknown');
    expect(m['payment_covers_minimum_upload']?.errorCode).toBe('blocked_by_network_unreachable');
    // Vendor error MUST NOT cross the boundary.
    expect(JSON.stringify(checks)).not.toContain('0xdeadbeef');
    expect(JSON.stringify(checks)).not.toContain('rpc 503');
  });

  it('sanitization: allowance numerics never appear in serialized checks', async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        allowances: {
          isApproved: true,
          rateAllowance: 999_999_999n,
          rateUsed: 0n,
          lockupAllowance: 888_888_888n,
          lockupUsed: 0n,
        },
      }),
    });
    const json = JSON.stringify(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(json).not.toContain('999999999');
    expect(json).not.toContain('888888888');
    expect(json).not.toContain('rateAllowance');
    expect(json).not.toContain('lockupAllowance');
  });
});

describe('synapseCheckReadiness — provider_ids / no providers', () => {
  it("reports no_providers_listed when no operator pins AND SDK returns empty providers", async () => {
    const fake = buildFake({ info: fakeStorageInfo({ providers: [] }) });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['provider_ids_reachable']?.status).toBe('failed');
    expect(m['provider_ids_reachable']?.errorCode).toBe('no_providers_listed');
  });

  it('reports provider_id_not_listed when a configured ID is absent from the SDK list', async () => {
    const fake = buildFake({ info: fakeStorageInfo({ providers: [{ id: 1n }] }) });
    const opts: ReadinessProbeOptions = { ...NO_BOUNDS, providerIds: ['1', '2'] };
    const m = byName(await synapseCheckReadiness(fake, opts, 'calibration'));
    expect(m['provider_ids_reachable']?.status).toBe('failed');
    expect(m['provider_ids_reachable']?.errorCode).toBe('provider_id_not_listed');
  });

  it('reports passed when every configured ID is present', async () => {
    const fake = buildFake({
      info: fakeStorageInfo({ providers: [{ id: 1n }, { id: 2n }, { id: 3n }] }),
    });
    const opts: ReadinessProbeOptions = { ...NO_BOUNDS, providerIds: ['1', '3'] };
    const m = byName(await synapseCheckReadiness(fake, opts, 'calibration'));
    expect(m['provider_ids_reachable']?.status).toBe('passed');
  });
});

describe('synapseCheckReadiness — data_set_available', () => {
  it('reports unknown / data_set_not_yet_created on cold-start (no data sets owned)', async () => {
    const fake = buildFake({ dataSets: [] });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['data_set_available']?.status).toBe('unknown');
    expect(m['data_set_available']?.errorCode).toBe('data_set_not_yet_created');
  });

  it('reports passed once at least one data set is owned', async () => {
    const fake = buildFake({ dataSets: [{ dataSetId: 42n, providerId: 1n }] });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['data_set_available']?.status).toBe('passed');
  });

  it('reports failed / network_unreachable when findDataSets throws', async () => {
    const fake = buildFake({ dataSetsError: new Error('rpc 500') });
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['data_set_available']?.status).toBe('failed');
    expect(m['data_set_available']?.errorCode).toBe('network_unreachable');
  });
});

describe('synapseCheckReadiness — upload size bounds', () => {
  it("reports failed when operator's maxUploadBytes exceeds the SDK service max", async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        serviceParameters: { minUploadSize: 127, maxUploadSize: 1_000_000 },
      }),
    });
    const opts: ReadinessProbeOptions = { ...NO_BOUNDS, maxUploadBytes: 2_000_000 };
    const m = byName(await synapseCheckReadiness(fake, opts, 'calibration'));
    expect(m['upload_size_bounds_compatible']?.errorCode).toBe('max_upload_exceeds_service');
  });

  it("reports failed when operator's minUploadBytes is below the SDK service min", async () => {
    const fake = buildFake({
      info: fakeStorageInfo({
        serviceParameters: { minUploadSize: 127, maxUploadSize: 1_000_000 },
      }),
    });
    const opts: ReadinessProbeOptions = { ...NO_BOUNDS, minUploadBytes: 64 };
    const m = byName(await synapseCheckReadiness(fake, opts, 'calibration'));
    expect(m['upload_size_bounds_compatible']?.errorCode).toBe('min_upload_below_service');
  });

  it('reports passed when no operator bounds are configured', async () => {
    const fake = buildFake({});
    const m = byName(await synapseCheckReadiness(fake, NO_BOUNDS, 'calibration'));
    expect(m['upload_size_bounds_compatible']?.status).toBe('passed');
  });
});

describe('aggregator + delegation', () => {
  it('aggregator collapses all-passed to ready=false because retrieval is unknown', async () => {
    const fake = buildFake({ dataSets: [{ dataSetId: 1n, providerId: 1n }] });
    const result = await checkFilecoinReadiness(
      new SynapseFilecoinProviderClient(fake),
      'calibration',
    );
    // Even with everything else green, `retrieval_available` stays
    // 'unknown' in this release — the aggregator MUST report
    // ready=false until a real retrieval probe is available.
    expect(result.ready).toBe(false);
    expect(result.network).toBe('calibration');
    expect(result.provider).toBe('filecoin');
    expect(result.driver).toBe('synapse');
  });

  it('aggregator output stays JSON-serializable (no bigints leak)', async () => {
    const fake = buildFake({});
    const result = await checkFilecoinReadiness(
      new SynapseFilecoinProviderClient(fake),
      'calibration',
    );
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('empty checks list ⇒ ready=false (fail-closed)', () => {
    expect(aggregateFilecoinReadiness([])).toBe(false);
  });
});
