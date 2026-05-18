/**
 * Shared fixtures for raw-storage config validation tests.
 *
 * The validation surface has provider-specific startup gates, so the
 * focused test files share a small set of complete config objects
 * instead of duplicating every nullable runtime field in each file.
 */

import { randomBytes } from 'node:crypto';
import type { RawStorageValidationInput } from '../config.js';

export const EMPTY_RING: ReadonlyMap<string, Buffer> = new Map();
export const ONE_KEY_RING: ReadonlyMap<string, Buffer> = new Map([['v1', randomBytes(32)]]);

export const POINTER_ONLY: RawStorageValidationInput = {
  mode: 'pointer_only',
  provider: null,
  prefix: '',
  localFsRoot: null,
  s3Bucket: null,
  s3Region: null,
  s3AccessKeyId: null,
  s3SecretAccessKey: null,
  codec: 'none',
  codecKeys: EMPTY_RING,
  codecActiveKeyId: null,
  deploymentEnv: 'local',
  legacyProviders: [],
  filecoinEnvKeysSet: [],
};

export const VALID_LOCAL_FS: RawStorageValidationInput = {
  ...POINTER_ONLY,
  mode: 'managed_blob',
  provider: 'local_fs',
  prefix: 'prod/core',
  localFsRoot: '/var/lib/atomicmem-raw',
};

export const VALID_S3: RawStorageValidationInput = {
  ...POINTER_ONLY,
  mode: 'managed_blob',
  provider: 's3',
  prefix: 'prod/core',
  s3Bucket: 'atomicmem-raw',
  s3Region: 'us-east-1',
  s3AccessKeyId: 'id',
  s3SecretAccessKey: 'secret',
};

/** Complete Filecoin fixture for provider-selection tests. */
export const VALID_FILECOIN_ENCRYPTED: RawStorageValidationInput = {
  ...POINTER_ONLY,
  mode: 'managed_blob',
  provider: 'filecoin',
  prefix: 'prod/core',
  codec: 'aes_gcm',
  codecKeys: ONE_KEY_RING,
  codecActiveKeyId: 'v1',
  deploymentEnv: 'production',
};
