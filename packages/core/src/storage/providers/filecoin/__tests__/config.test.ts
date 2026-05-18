/**
 * @file Tests for `parseFilecoinProviderConfig` + `parseFilecoinPrivateKey`.
 *
 * The parser is a pure function over a plain env object — tests
 * pass fixtures directly, no `process.env` stubbing. The DATA_SET_
 * METADATA branch exercises the bounded key/value/scalar / reserved-
 * prefix / denylist rules. The private-key validator is asserted to
 * NEVER include the supplied value in its rejection message (so a
 * mistyped key cannot leak through logs or stack traces).
 */

import { describe, expect, it } from 'vitest';
import {
  collectFilecoinProviderEnvKeys,
  parseFilecoinPrivateKey,
  parseFilecoinProviderConfig,
} from '../config.js';

const VALID_TEST_PRIVATE_KEY = `0x${'0123456789abcdef'.repeat(4)}`;

const REQUIRED_BASE: Record<string, string | undefined> = {
  RAW_STORAGE_FILECOIN_DRIVER: 'synapse',
  RAW_STORAGE_FILECOIN_NETWORK: 'calibration',
  RAW_STORAGE_FILECOIN_PRIVATE_KEY: VALID_TEST_PRIVATE_KEY,
  RAW_STORAGE_FILECOIN_SOURCE: 'atomicmemory-core',
  RAW_STORAGE_FILECOIN_WITH_CDN: 'false',
};

describe('parseFilecoinPrivateKey', () => {
  it('accepts a lowercase 0x-prefixed 32-byte hex string', () => {
    const key = '0x' + 'a'.repeat(64);
    expect(parseFilecoinPrivateKey(key)).toBe(key);
  });

  it('accepts mixed-case hex characters', () => {
    const key = '0x' + 'Aa'.repeat(32);
    expect(parseFilecoinPrivateKey(key)).toBe(key);
  });

  it.each([
    ['empty', ''],
    ['missing prefix', 'a'.repeat(64)],
    ['too short', '0x' + 'a'.repeat(63)],
    ['too long', '0x' + 'a'.repeat(65)],
    ['non-hex chars', '0x' + 'g'.repeat(64)],
    ['whitespace', '0x' + ' '.repeat(64)],
    ['uppercase 0X prefix', '0X' + 'a'.repeat(64)],
  ])('rejects %s without echoing the value', (_label, bad) => {
    let captured: unknown;
    try {
      parseFilecoinPrivateKey(bad);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    const message = (captured as Error).message;
    expect(message).toMatch(/RAW_STORAGE_FILECOIN_PRIVATE_KEY/);
    if (bad.length > 0) expect(message).not.toContain(bad);
  });
});

describe('parseFilecoinProviderConfig — required fields', () => {
  it('accepts the minimum-required env block and returns a typed config', () => {
    const config = parseFilecoinProviderConfig(REQUIRED_BASE);
    expect(config).toMatchObject({
      driver: 'synapse',
      network: 'calibration',
      source: 'atomicmemory-core',
      withCdn: false,
      providerIds: [],
      copies: null,
      dataSetMetadata: {},
      maxUploadBytes: null,
      minUploadBytes: null,
      uploadTimeoutMs: null,
      retrievalTimeoutMs: null,
    });
  });

  it.each([
    'RAW_STORAGE_FILECOIN_DRIVER',
    'RAW_STORAGE_FILECOIN_NETWORK',
    'RAW_STORAGE_FILECOIN_PRIVATE_KEY',
    'RAW_STORAGE_FILECOIN_SOURCE',
    'RAW_STORAGE_FILECOIN_WITH_CDN',
  ])('rejects missing %s', (missing) => {
    const env = { ...REQUIRED_BASE };
    delete env[missing];
    expect(() => parseFilecoinProviderConfig(env)).toThrow(missing);
  });

  it("rejects a driver other than 'synapse'", () => {
    expect(() =>
      parseFilecoinProviderConfig({ ...REQUIRED_BASE, RAW_STORAGE_FILECOIN_DRIVER: 'web3up' }),
    ).toThrow(/synapse/);
  });

  it.each(['mainnet-beta', 'devnet', ''])('rejects invalid network value %p', (bad) => {
    expect(() =>
      parseFilecoinProviderConfig({ ...REQUIRED_BASE, RAW_STORAGE_FILECOIN_NETWORK: bad }),
    ).toThrow(/RAW_STORAGE_FILECOIN_NETWORK/);
  });

  it('accepts mainnet as the alternate network', () => {
    const config = parseFilecoinProviderConfig({
      ...REQUIRED_BASE,
      RAW_STORAGE_FILECOIN_NETWORK: 'mainnet',
    });
    expect(config.network).toBe('mainnet');
  });

  it("rejects WITH_CDN values that are not 'true' / 'false'", () => {
    expect(() =>
      parseFilecoinProviderConfig({ ...REQUIRED_BASE, RAW_STORAGE_FILECOIN_WITH_CDN: 'TRUE' }),
    ).toThrow(/RAW_STORAGE_FILECOIN_WITH_CDN/);
  });
});

describe('parseFilecoinProviderConfig — optional fields', () => {
  it('parses provider_ids as a trimmed csv of positive decimal bigint strings', () => {
    const config = parseFilecoinProviderConfig({
      ...REQUIRED_BASE,
      RAW_STORAGE_FILECOIN_PROVIDER_IDS: ' 1 , 42 , 12345 ',
    });
    expect(config.providerIds).toEqual(['1', '42', '12345']);
  });

  it.each([
    ['abc', 'non-numeric'],
    ['1.2', 'fractional'],
    ['-1', 'negative'],
    ['0', 'zero (provider IDs are positive)'],
    ['0x10', 'hex form (Synapse expects decimal)'],
    ['01', 'leading zero'],
    ['1e3', 'scientific'],
    ['+5', 'explicit positive sign'],
  ])('rejects provider_ids entry %p (%s)', (entry) => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_PROVIDER_IDS: entry,
      }),
    ).toThrow(/positive decimal bigint/);
  });

  it('catches an invalid entry sitting alongside valid ones', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_PROVIDER_IDS: '1,2,abc,4',
      }),
    ).toThrow(/positive decimal bigint/);
  });

  it('rejects duplicate provider_ids entries', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_PROVIDER_IDS: '1,2,1',
      }),
    ).toThrow(/duplicate/);
  });

  it('returns an empty provider_ids array on blank/missing input', () => {
    expect(
      parseFilecoinProviderConfig({ ...REQUIRED_BASE, RAW_STORAGE_FILECOIN_PROVIDER_IDS: '' })
        .providerIds,
    ).toEqual([]);
    expect(parseFilecoinProviderConfig(REQUIRED_BASE).providerIds).toEqual([]);
  });

  it.each([
    ['RAW_STORAGE_FILECOIN_COPIES', 'copies'],
    ['RAW_STORAGE_FILECOIN_MAX_UPLOAD_BYTES', 'maxUploadBytes'],
    ['RAW_STORAGE_FILECOIN_MIN_UPLOAD_BYTES', 'minUploadBytes'],
    ['RAW_STORAGE_FILECOIN_UPLOAD_TIMEOUT_MS', 'uploadTimeoutMs'],
    ['RAW_STORAGE_FILECOIN_RETRIEVAL_TIMEOUT_MS', 'retrievalTimeoutMs'],
  ] as const)('parses positive integer %s', (envKey, field) => {
    const config = parseFilecoinProviderConfig({ ...REQUIRED_BASE, [envKey]: '42' });
    expect(config[field]).toBe(42);
  });

  it.each([
    ['0', 'zero'],
    ['-1', 'negative'],
    ['1.5', 'fractional'],
    ['abc', 'non-numeric'],
  ])('rejects positive-int env value %s (%s)', (bad) => {
    expect(() =>
      parseFilecoinProviderConfig({ ...REQUIRED_BASE, RAW_STORAGE_FILECOIN_COPIES: bad }),
    ).toThrow(/RAW_STORAGE_FILECOIN_COPIES/);
  });
});

describe('parseFilecoinProviderConfig — data set metadata', () => {
  it('accepts a small object with scalar values', () => {
    const config = parseFilecoinProviderConfig({
      ...REQUIRED_BASE,
      RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({
        tenant: 'acme',
        purpose: 'docs',
        sla_tier: 2,
        archived: false,
      }),
    });
    expect(config.dataSetMetadata).toEqual({
      tenant: 'acme',
      purpose: 'docs',
      sla_tier: 2,
      archived: false,
    });
  });

  it('rejects non-object JSON (array)', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: '[1,2,3]',
      }),
    ).toThrow(/JSON object/);
  });

  it('rejects nested objects (non-scalar values)', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ nested: { k: 'v' } }),
      }),
    ).toThrow(/scalar/);
  });

  it.each(['atomicmemory.tenant', 'synapse.something', 'filecoin.deal', '_internal'])(
    'rejects reserved-prefix key %p',
    (key) => {
      expect(() =>
        parseFilecoinProviderConfig({
          ...REQUIRED_BASE,
          RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [key]: 'x' }),
        }),
      ).toThrow(/reserved prefix/);
    },
  );

  it.each([
    ['private_key', 'denylist exact match'],
    ['Wallet_Address', 'denylist substring (case-insensitive)'],
    ['my_auth_header', 'denylisted credential shape'],
  ])('rejects denylisted key %p (%s)', (key) => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [key]: 'x' }),
      }),
    ).toThrow(/denylisted credential shape/);
  });

  it('accepts exactly 10 keys (Synapse MAX_KEYS_PER_DATASET boundary)', () => {
    const at_limit: Record<string, string> = {};
    for (let i = 0; i < 10; i++) at_limit[`k${i}`] = 'v';
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify(at_limit),
      }),
    ).not.toThrow();
  });

  it('rejects > 10 keys', () => {
    const over_limit: Record<string, string> = {};
    for (let i = 0; i < 11; i++) over_limit[`k${i}`] = 'v';
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify(over_limit),
      }),
    ).toThrow(/10 keys/);
  });

  it('rejects keys longer than 32 characters (Synapse MAX_KEY_LENGTH)', () => {
    const long = 'k'.repeat(33);
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [long]: 'v' }),
      }),
    ).toThrow(/key length must be/);
  });

  it('accepts keys of exactly 32 characters', () => {
    const at = 'k'.repeat(32);
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [at]: 'v' }),
      }),
    ).not.toThrow();
  });

  it.each([
    ['has spaces', 'with space'],
    ['has slash', 'a/b'],
    ['has plus', 'a+b'],
    ['unicode letter', 'å'],
    ['has paren', 'k(1)'],
  ])('rejects key with disallowed characters: %s (%p)', (_label, key) => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [key]: 'v' }),
      }),
    ).toThrow(/disallowed characters/);
  });

  it.each(['k_1', 'K-1', 'a.b.c', 'org:tenant', '123_4', 'A_B-C.D:E'])(
    'accepts key matching [A-Za-z0-9_.:-]+ (%p)',
    (key) => {
      expect(() =>
        parseFilecoinProviderConfig({
          ...REQUIRED_BASE,
          RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ [key]: 'v' }),
        }),
      ).not.toThrow();
    },
  );

  it('caps string values at 128 characters (Synapse MAX_VALUE_LENGTH boundary)', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ k: 'x'.repeat(128) }),
      }),
    ).not.toThrow();
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ k: 'x'.repeat(129) }),
      }),
    ).toThrow(/128 characters/);
  });

  it('counts JS string length (UTF-16 code units) for the 128-character cap, matching Synapse', () => {
    // '😀' is a surrogate pair → JS `.length === 2` per emoji.
    // 65 emojis = .length 130 > 128 → rejected.
    const justOver = '😀'.repeat(65);
    expect(justOver.length).toBe(130);
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ k: justOver }),
      }),
    ).toThrow(/128 characters/);
  });

  it.each([
    ['private-key-looking hex', '0x' + 'a'.repeat(64)],
    ['private_key text', 'my private_key is 1234'],
    ['Bearer token', 'Bearer eyJabc.def.ghi'],
    ['Authorization phrase', 'Authorization: token xyz'],
    ['UCAN proof phrase', 'ucan proof attached'],
    ['signed-request phrase', 'signed-request payload'],
    ['JWT-shaped', 'eyJhbGciOi.eyJpc3Mi.SflKxwRJSMeKKF2'],
  ])('rejects credential-shaped value: %s', (_label, value) => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: JSON.stringify({ tenant: value }),
      }),
    ).toThrow(/denylisted credential shape/);
  });

  it('rejects malformed JSON', () => {
    expect(() =>
      parseFilecoinProviderConfig({
        ...REQUIRED_BASE,
        RAW_STORAGE_FILECOIN_DATA_SET_METADATA: '{not json',
      }),
    ).toThrow(/valid JSON/);
  });
});

describe('collectFilecoinProviderEnvKeys', () => {
  it('returns every RAW_STORAGE_FILECOIN_* key with a non-empty value', () => {
    const keys = collectFilecoinProviderEnvKeys({
      RAW_STORAGE_FILECOIN_DRIVER: 'synapse',
      RAW_STORAGE_FILECOIN_NETWORK: 'mainnet',
      RAW_STORAGE_FILECOIN_PROVIDER_IDS: '',
      RAW_STORAGE_PROVIDER: 's3',
      OTHER: 'x',
    });
    expect(keys.slice().sort()).toEqual([
      'RAW_STORAGE_FILECOIN_DRIVER',
      'RAW_STORAGE_FILECOIN_NETWORK',
    ]);
  });

  it('returns an empty list when no filecoin vars are set', () => {
    expect(
      collectFilecoinProviderEnvKeys({ RAW_STORAGE_PROVIDER: 's3', SOMETHING: '1' }),
    ).toEqual([]);
  });
});
