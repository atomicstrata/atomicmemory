/**
 * Cross-field config validation for the raw-storage knobs.
 *
 * `validateRawStorageConfig` runs once at startup. Pure function — no
 * env reads, no module side effects — so we can hammer it with the
 * full matrix of mis-configurations without restarting the loader.
 *
 * Filecoin provider selection no longer accepts legacy onramp
 * credentials here. Synapse-specific validation lives in
 * `src/storage/providers/filecoin/config.ts`; central
 * cross-provider rejection lives in `src/config.ts`.
 */

import { describe, expect, it } from 'vitest';
import { validateRawStorageConfig, type RawStorageValidationInput } from '../config.js';
import {
  EMPTY_RING,
  ONE_KEY_RING,
  POINTER_ONLY,
  VALID_FILECOIN_ENCRYPTED,
  VALID_LOCAL_FS,
  VALID_S3,
} from './raw-storage-config-fixtures.js';

describe('validateRawStorageConfig — pointer_only + local_fs + s3 baselines', () => {
  it('accepts pointer_only with no provider knobs', () => {
    expect(() => validateRawStorageConfig(POINTER_ONLY)).not.toThrow();
  });

  it('rejects RAW_STORAGE_PROVIDER set without managed_blob', () => {
    expect(() =>
      validateRawStorageConfig({ ...POINTER_ONLY, provider: 'local_fs' }),
    ).toThrow(/managed_blob/);
  });

  it('rejects managed_blob with no provider', () => {
    expect(() =>
      validateRawStorageConfig({ ...POINTER_ONLY, mode: 'managed_blob' }),
    ).toThrow(/RAW_STORAGE_PROVIDER/);
  });

  it('accepts managed_blob + local_fs with a root', () => {
    expect(() => validateRawStorageConfig(VALID_LOCAL_FS)).not.toThrow();
  });

  it('rejects managed_blob + local_fs without a root', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, localFsRoot: null }),
    ).toThrow(/RAW_STORAGE_LOCAL_FS_ROOT/);
  });

  it('accepts managed_blob + s3 with all required fields', () => {
    expect(() => validateRawStorageConfig(VALID_S3)).not.toThrow();
  });

  it.each([
    ['s3Bucket', 'RAW_STORAGE_S3_BUCKET'],
    ['s3Region', 'RAW_STORAGE_S3_REGION'],
    ['s3AccessKeyId', 'RAW_STORAGE_S3_ACCESS_KEY_ID'],
    ['s3SecretAccessKey', 'RAW_STORAGE_S3_SECRET_ACCESS_KEY'],
  ] as const)('rejects managed_blob + s3 missing %s', (field, envName) => {
    const cfg = { ...VALID_S3, [field]: null } as RawStorageValidationInput;
    expect(() => validateRawStorageConfig(cfg)).toThrow(envName);
  });

  it('rejects managed_blob without RAW_STORAGE_PREFIX', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, prefix: '' }),
    ).toThrow(/RAW_STORAGE_PREFIX/);
  });

  it('rejects whitespace-only RAW_STORAGE_PREFIX', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, prefix: '   ' }),
    ).toThrow(/RAW_STORAGE_PREFIX/);
  });

  it('rejects RAW_STORAGE_PREFIX with leading slash (absolute path)', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, prefix: '/abs/prefix' }),
    ).toThrow(/relative/);
  });

  it('rejects RAW_STORAGE_PREFIX with .. segments', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, prefix: 'env/../escape' }),
    ).toThrow(/'\.\.'/);
  });

  it('accepts pointer_only with empty prefix', () => {
    expect(() =>
      validateRawStorageConfig({ ...POINTER_ONLY, prefix: '' }),
    ).not.toThrow();
  });
});

describe('validateRawStorageConfig — codec keyring', () => {
  it('accepts codec=none with empty ring', () => {
    expect(() => validateRawStorageConfig(POINTER_ONLY)).not.toThrow();
  });

  it("rejects codec=none with non-empty keyring (stale knobs)", () => {
    expect(() =>
      validateRawStorageConfig({ ...POINTER_ONLY, codecKeys: ONE_KEY_RING }),
    ).toThrow(/RAW_CONTENT_CODEC_KEYS/);
  });

  it("rejects codec=none with active key id set (stale knob)", () => {
    expect(() =>
      validateRawStorageConfig({ ...POINTER_ONLY, codecActiveKeyId: 'v1' }),
    ).toThrow(/_ACTIVE_KEY_ID/);
  });

  it('rejects codec=aes_gcm with empty keyring', () => {
    expect(() =>
      validateRawStorageConfig({
        ...POINTER_ONLY,
        codec: 'aes_gcm',
        codecKeys: EMPTY_RING,
        codecActiveKeyId: 'v1',
      }),
    ).toThrow(/RAW_CONTENT_CODEC_KEYS/);
  });

  it('rejects codec=aes_gcm with no active key id', () => {
    expect(() =>
      validateRawStorageConfig({
        ...POINTER_ONLY,
        codec: 'aes_gcm',
        codecKeys: ONE_KEY_RING,
        codecActiveKeyId: null,
      }),
    ).toThrow(/_ACTIVE_KEY_ID/);
  });

  it('rejects codec=aes_gcm with active key id absent from the ring', () => {
    expect(() =>
      validateRawStorageConfig({
        ...POINTER_ONLY,
        codec: 'aes_gcm',
        codecKeys: ONE_KEY_RING,
        codecActiveKeyId: 'mismatch',
      }),
    ).toThrow(/mismatch/);
  });

  it('accepts codec=aes_gcm with a populated ring (paired with local_fs)', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_LOCAL_FS,
        codec: 'aes_gcm',
        codecKeys: ONE_KEY_RING,
        codecActiveKeyId: 'v1',
      }),
    ).not.toThrow();
  });
});

describe('validateRawStorageConfig — filecoin', () => {
  it('accepts encrypted provider selection in any deployment env', () => {
    expect(() => validateRawStorageConfig(VALID_FILECOIN_ENCRYPTED)).not.toThrow();
    expect(() =>
      validateRawStorageConfig({ ...VALID_FILECOIN_ENCRYPTED, deploymentEnv: 'staging' }),
    ).not.toThrow();
    expect(() =>
      validateRawStorageConfig({ ...VALID_FILECOIN_ENCRYPTED, deploymentEnv: 'local' }),
    ).not.toThrow();
  });

  it('rejects plaintext Filecoin storage outside local development', () => {
    const plaintextFilecoin = {
      ...VALID_FILECOIN_ENCRYPTED,
      codec: 'none' as const,
      codecKeys: EMPTY_RING,
      codecActiveKeyId: null,
    };
    expect(() =>
      validateRawStorageConfig({ ...plaintextFilecoin, deploymentEnv: 'production' }),
    ).toThrow(/requires RAW_CONTENT_CODEC='aes_gcm'/);
    expect(() =>
      validateRawStorageConfig({ ...plaintextFilecoin, deploymentEnv: 'staging' }),
    ).toThrow(/requires RAW_CONTENT_CODEC='aes_gcm'/);
  });

  it('allows plaintext Filecoin storage only for local development', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_FILECOIN_ENCRYPTED,
        codec: 'none',
        codecKeys: EMPTY_RING,
        codecActiveKeyId: null,
        deploymentEnv: 'local',
      }),
    ).not.toThrow();
  });

  it('does not require codec for local_fs/s3 even in production', () => {
    expect(() =>
      validateRawStorageConfig({ ...VALID_LOCAL_FS, deploymentEnv: 'production' }),
    ).not.toThrow();
    expect(() =>
      validateRawStorageConfig({ ...VALID_S3, deploymentEnv: 'production' }),
    ).not.toThrow();
  });
});

describe('validateRawStorageConfig — cross-provider RAW_STORAGE_FILECOIN_* guard', () => {
  it('rejects RAW_STORAGE_FILECOIN_* vars when provider is s3', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_S3,
        filecoinEnvKeysSet: ['RAW_STORAGE_FILECOIN_DRIVER', 'RAW_STORAGE_FILECOIN_NETWORK'],
      }),
    ).toThrow(/RAW_STORAGE_FILECOIN_\*/);
  });

  it('rejects RAW_STORAGE_FILECOIN_* vars when provider is local_fs', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_LOCAL_FS,
        filecoinEnvKeysSet: ['RAW_STORAGE_FILECOIN_PRIVATE_KEY'],
      }),
    ).toThrow(/RAW_STORAGE_FILECOIN_\*/);
  });

  it('rejects RAW_STORAGE_FILECOIN_* vars when mode is pointer_only', () => {
    expect(() =>
      validateRawStorageConfig({
        ...POINTER_ONLY,
        filecoinEnvKeysSet: ['RAW_STORAGE_FILECOIN_SOURCE'],
      }),
    ).toThrow(/RAW_STORAGE_FILECOIN_\*/);
  });

  it('lists every set var in the rejection message', () => {
    let err: unknown;
    try {
      validateRawStorageConfig({
        ...VALID_S3,
        filecoinEnvKeysSet: ['RAW_STORAGE_FILECOIN_DRIVER', 'RAW_STORAGE_FILECOIN_NETWORK'],
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('RAW_STORAGE_FILECOIN_DRIVER');
    expect((err as Error).message).toContain('RAW_STORAGE_FILECOIN_NETWORK');
  });

  it('passes when provider IS filecoin even with vars set', () => {
    expect(() =>
      validateRawStorageConfig({
        ...VALID_FILECOIN_ENCRYPTED,
        filecoinEnvKeysSet: [
          'RAW_STORAGE_FILECOIN_DRIVER',
          'RAW_STORAGE_FILECOIN_NETWORK',
          'RAW_STORAGE_FILECOIN_PRIVATE_KEY',
        ],
      }),
    ).not.toThrow();
  });
});
