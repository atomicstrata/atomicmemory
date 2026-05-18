/**
 * @file Test-client shape coverage for `providers/filecoin/`.
 *
 * Locks the surface that the real provider and test stub share:
 *
 *   - `FilecoinRawContentStore` exposes the documented capabilities
 *     and throws `FilecoinNotImplementedError` for every method.
 *   - `SynapseFilecoinProviderClient` advertises
 *     `provider: 'filecoin'` / `driver: 'synapse'` and rejects every
 *     provider operation with `FilecoinNotImplementedError`.
 *   - `checkFilecoinReadiness` returns `ready: false` with the
 *     documented check names, all stubbed `'unknown' / 'not_implemented'`.
 *   - `ALLOWED_FILECOIN_METADATA_KEYS`,
 *     `FILECOIN_METADATA_DENYLIST`, and
 *     `FILECOIN_METADATA_RESERVED_PREFIXES` pin the closed sets the
 *     metadata projector consumes.
 *
 * These tests intentionally exercise the test stub — they are NOT
 * fake reachability anchors.
 */

import { describe, expect, it } from 'vitest';
import { FilecoinRawContentStore } from '../backend.js';
import { SkeletonFilecoinProviderClient } from '../skeleton-client.js';
import { FilecoinNotImplementedError } from '../errors.js';
import { checkFilecoinReadiness } from '../readiness.js';
import {
  ALLOWED_FILECOIN_METADATA_KEYS,
  FILECOIN_METADATA_DENYLIST,
  FILECOIN_METADATA_RESERVED_PREFIXES,
} from '../metadata.js';
import type { FilecoinDriver, FilecoinNetwork } from '../config.js';

describe('FilecoinRawContentStore wrapping the test SkeletonFilecoinProviderClient', () => {
  // The test client is a TEST-ONLY fake used to exercise the
  // adapter's error-propagation behavior. Production never wraps
  // it (the factory throws when filecoinProvider is null). The
  // adapter still advertises `supportsHead/Get=true` because that
  // describes the real Synapse-backed client — the test client is
  // standing in just to verify "adapter delegates and re-throws
  // the underlying error" without standing up a real Synapse
  // handle.
  const store = new FilecoinRawContentStore(new SkeletonFilecoinProviderClient());

  it('exposes the canonical provider name', () => {
    expect(store.provider).toBe('filecoin');
  });

  it('propagates the underlying client error on every method', async () => {
    await expect(store.put({ key: 'k', body: Buffer.alloc(0) }))
      .rejects.toBeInstanceOf(FilecoinNotImplementedError);
    await expect(store.get('filecoin://piece/x'))
      .rejects.toBeInstanceOf(FilecoinNotImplementedError);
    await expect(store.head('filecoin://piece/x'))
      .rejects.toBeInstanceOf(FilecoinNotImplementedError);
    await expect(store.delete('filecoin://piece/x'))
      .rejects.toBeInstanceOf(FilecoinNotImplementedError);
  });
});

describe('SkeletonFilecoinProviderClient — null-config stub', () => {
  const client = new SkeletonFilecoinProviderClient();

  it('advertises provider=filecoin / driver=synapse', () => {
    expect(client.provider).toBe('filecoin');
    expect(client.driver).toBe('synapse');
  });

  it('rejects every provider operation with FilecoinNotImplementedError carrying error_code=filecoin_not_implemented', async () => {
    const cases = [
      () => client.put({ key: 'k', body: Buffer.alloc(0) }),
      () => client.get({ storageUri: 'filecoin://piece/x' }),
      () => client.head({ storageUri: 'filecoin://piece/x' }),
      () => client.delete({ storageUri: 'filecoin://piece/x' }),
      () => client.verify({ storageUri: 'filecoin://piece/x', expectedContentHash: 'h' }),
    ];
    for (const op of cases) {
      const err = await op().then(
        () => { throw new Error('expected throw'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FilecoinNotImplementedError);
      expect((err as FilecoinNotImplementedError).errorCode).toBe('filecoin_not_implemented');
    }
  });
});

describe('checkFilecoinReadiness — test stub', () => {
  const expectedCheckNames = [
    'network_reachable',
    'key_loadable',
    'account_on_expected_network',
    'payment_covers_minimum_upload',
    'provider_ids_reachable',
    'data_set_available',
    'retrieval_available',
    'upload_size_bounds_compatible',
  ] as const;

  it('returns ready=false with every documented check stubbed unknown', async () => {
    const result = await checkFilecoinReadiness(
      new SkeletonFilecoinProviderClient(),
      'calibration',
    );
    expect(result.provider).toBe('filecoin');
    expect(result.driver).toBe('synapse');
    expect(result.network).toBe('calibration');
    expect(result.ready).toBe(false);
    expect(result.checks.map((c) => c.name)).toEqual([...expectedCheckNames]);
    for (const check of result.checks) {
      expect(check.status).toBe('unknown');
      expect(check.errorCode).toBe('not_implemented');
    }
  });

  it('reports the same shape on mainnet', async () => {
    const result = await checkFilecoinReadiness(
      new SkeletonFilecoinProviderClient(),
      'mainnet',
    );
    expect(result.network).toBe('mainnet');
    expect(result.ready).toBe(false);
  });
});

describe('Filecoin metadata constants', () => {
  it('pins the allowlist to the closed set documented in the design doc', () => {
    expect([...ALLOWED_FILECOIN_METADATA_KEYS]).toEqual([
      'artifact_id',
      'storage_profile_id',
      'content_type',
      'stored_hash',
      'codec_name',
      'codec_version',
      'codec_key_id',
      'source_kind',
    ]);
  });

  it('denylist names high-risk keys upload metadata must reject', () => {
    expect(FILECOIN_METADATA_DENYLIST).toContain('private_key');
    expect(FILECOIN_METADATA_DENYLIST).toContain('wallet_address');
    expect(FILECOIN_METADATA_DENYLIST).toContain('signed_request');
    expect(FILECOIN_METADATA_DENYLIST).toContain('ucan_proof');
  });

  it('reserved prefixes include the documented vendor namespaces', () => {
    expect([...FILECOIN_METADATA_RESERVED_PREFIXES]).toEqual([
      'atomicmemory.',
      'synapse.',
      'filecoin.',
      '_',
    ]);
  });
});

describe('FilecoinNetwork / FilecoinDriver types', () => {
  it('accepts the documented network and driver string literals', () => {
    const networks: FilecoinNetwork[] = ['calibration', 'mainnet'];
    const drivers: FilecoinDriver[] = ['synapse'];
    expect(networks).toHaveLength(2);
    expect(drivers).toHaveLength(1);
  });
});
