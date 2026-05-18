/**
 * Unit tests for `buildRawContentStore` (factory).
 *
 * The cross-field validation is tested separately against the env-loader
 * (`src/__tests__/raw-storage-config.test.ts`); this file covers the
 * factory's runtime branch — given an already-validated config object,
 * does it construct the right adapter?
 *
 * Filecoin provider tests replace legacy onramp adapter coverage with the
 * test-only Filecoin client wired through `providers/filecoin/`.
 */

import { describe, expect, it } from 'vitest';
import { buildRawContentStore } from '../factory.js';
import { LocalFsRawContentStore } from '../local-fs-store.js';
import { S3RawContentStore } from '../s3-store.js';
import { FilecoinRawContentStore } from '../providers/filecoin/index.js';
import type { RuntimeConfig } from '../../config.js';

type FactoryInput = Parameters<typeof buildRawContentStore>[0];

const NULL_RAW_STORAGE: FactoryInput = {
  rawStorageMode: 'pointer_only',
  rawStorageProvider: null,
  rawStorageLocalFsRoot: null,
  rawStorageS3Bucket: null,
  rawStorageS3Region: null,
  rawStorageS3Endpoint: null,
  rawStorageS3AccessKeyId: null,
  rawStorageS3SecretAccessKey: null,
  rawStorageDeploymentEnv: 'local',
  rawStorageLegacyProviders: [],
  filecoinProvider: null,
};

describe('buildRawContentStore', () => {
  it('returns null when rawStorageMode is pointer_only', async () => {
    expect(await buildRawContentStore(NULL_RAW_STORAGE)).toBeNull();
  });

  it('builds a LocalFsRawContentStore when provider=local_fs', async () => {
    const store = await buildRawContentStore({
      ...NULL_RAW_STORAGE,
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 'local_fs',
      rawStorageLocalFsRoot: '/tmp/raw-storage-test',
    });
    expect(store).toBeInstanceOf(LocalFsRawContentStore);
    expect(store?.provider).toBe('local_fs');
  });

  it('builds an S3RawContentStore when provider=s3', async () => {
    const store = await buildRawContentStore({
      ...NULL_RAW_STORAGE,
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 's3',
      rawStorageS3Bucket: 'b',
      rawStorageS3Region: 'us-east-1',
      rawStorageS3AccessKeyId: 'id',
      rawStorageS3SecretAccessKey: 'secret',
    });
    expect(store).toBeInstanceOf(S3RawContentStore);
    expect(store?.provider).toBe('s3');
  });

  it('factory-built local_fs and s3 stores expose their capabilities triple', async () => {
    const localFs = await buildRawContentStore({
      ...NULL_RAW_STORAGE,
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 'local_fs',
      rawStorageLocalFsRoot: '/tmp/raw-storage-capabilities-test',
    });
    expect(localFs?.capabilities.addressing).toBe('location');
    expect(localFs?.capabilities.retrievalConsistency).toBe('immediate');
    expect(localFs?.capabilities.deleteSemantics).toBe('delete');
    const s3 = await buildRawContentStore({
      ...NULL_RAW_STORAGE,
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 's3',
      rawStorageS3Bucket: 'b',
      rawStorageS3Region: 'us-east-1',
      rawStorageS3AccessKeyId: 'id',
      rawStorageS3SecretAccessKey: 'secret',
    });
    expect(s3?.capabilities.addressing).toBe('location');
    expect(s3?.capabilities.retrievalConsistency).toBe('immediate');
    expect(s3?.capabilities.deleteSemantics).toBe('delete');
  });

  it('throws if managed_blob is set but provider field is missing', async () => {
    await expect(
      buildRawContentStore({
        ...NULL_RAW_STORAGE,
        rawStorageMode: 'managed_blob',
        rawStorageProvider: null as unknown as RuntimeConfig['rawStorageProvider'],
      }),
    ).rejects.toThrow(/provider is missing|unknown/);
  });

  it('throws if local_fs root is missing despite mode/provider being set', async () => {
    await expect(
      buildRawContentStore({
        ...NULL_RAW_STORAGE,
        rawStorageMode: 'managed_blob',
        rawStorageProvider: 'local_fs',
        rawStorageLocalFsRoot: null,
      }),
    ).rejects.toThrow(/RAW_STORAGE_LOCAL_FS_ROOT/);
  });

  it('throws if s3 fields are missing despite mode/provider being set', async () => {
    await expect(
      buildRawContentStore({
        ...NULL_RAW_STORAGE,
        rawStorageMode: 'managed_blob',
        rawStorageProvider: 's3',
        rawStorageS3Bucket: 'b',
      }),
    ).rejects.toThrow(/bucket|region|access-key/i);
  });

  it('builds the Filecoin backend when provider=filecoin AND filecoinProvider config is present', async () => {
    const store = await buildRawContentStore({
      ...NULL_RAW_STORAGE,
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 'filecoin',
      rawStorageDeploymentEnv: 'local',
      filecoinProvider: {
        driver: 'synapse',
        network: 'calibration',
        // Deterministic test key (well-known anvil test seed). The
        // factory test runs viem's account derivation but performs
        // no network I/O.
        privateKey: '0x' + 'a'.repeat(64),
        source: 'atomicmemory-core-tests',
        withCdn: false,
        providerIds: [],
        copies: null,
        dataSetMetadata: {},
        maxUploadBytes: null,
        minUploadBytes: null,
        uploadTimeoutMs: null,
        retrievalTimeoutMs: null,
      },
    });
    expect(store).toBeInstanceOf(FilecoinRawContentStore);
    expect(store?.provider).toBe('filecoin');
    expect(store?.capabilities.addressing).toBe('content');
    expect(store?.capabilities.retrievalConsistency).toBe('eventual');
    expect(store?.capabilities.deleteSemantics).toBe('tombstone');
    expect(store?.capabilities.supportsHead).toBe(true);
    expect(store?.capabilities.supportsGet).toBe(true);
  });

  it('throws when provider=filecoin but filecoinProvider config is null (defense-in-depth)', async () => {
    await expect(
      buildRawContentStore({
        ...NULL_RAW_STORAGE,
        rawStorageMode: 'managed_blob',
        rawStorageProvider: 'filecoin',
        rawStorageDeploymentEnv: 'local',
        filecoinProvider: null,
      }),
    ).rejects.toThrow(/filecoinProvider config is null/);
  });
});
