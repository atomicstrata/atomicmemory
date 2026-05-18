/**
 * Focused config validation tests for legacy raw-storage providers.
 * Legacy provider registration is separate from active-provider
 * construction because it exists only for cleanup dispatch of older
 * managed rows.
 */

import { describe, expect, it } from 'vitest';
import { validateRawStorageConfig } from '../config.js';
import { VALID_FILECOIN_ENCRYPTED, VALID_LOCAL_FS } from './raw-storage-config-fixtures.js';

describe('validateRawStorageConfig — legacy providers', () => {
  it('accepts an empty legacy-providers list', () => {
    expect(() => validateRawStorageConfig(VALID_FILECOIN_ENCRYPTED)).not.toThrow();
  });

  it('accepts legacy=s3 when the full S3 env block is present', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_FILECOIN_ENCRYPTED,
        legacyProviders: ['s3'],
        s3Bucket: 'b',
        s3Region: 'r',
        s3AccessKeyId: 'id',
        s3SecretAccessKey: 's',
      }),
    ).not.toThrow();
  });

  it('rejects legacy=s3 missing a credential field', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_FILECOIN_ENCRYPTED,
        legacyProviders: ['s3'],
        s3Bucket: 'b',
        s3Region: 'r',
        s3AccessKeyId: 'id',
      }),
    ).toThrow(/RAW_STORAGE_S3_SECRET_ACCESS_KEY/);
  });

  it('rejects legacy=local_fs missing the root', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_FILECOIN_ENCRYPTED,
        legacyProviders: ['local_fs'],
      }),
    ).toThrow(/RAW_STORAGE_LOCAL_FS_ROOT/);
  });

  it('rejects a provider that is both active and legacy', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, legacyProviders: ['local_fs'] }),
    ).toThrow(/active and legacy/);
  });

  it('rejects Filecoin-family providers in the legacy list', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, legacyProviders: ['filecoin'] }),
    ).toThrow(/cannot include 'filecoin'/);
  });
});
