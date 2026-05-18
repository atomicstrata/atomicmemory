/**
 * @file Tests for `buildFilecoinMetadata` and the upload-side
 * allowlist / denylist / reserved-prefix constants.
 *
 * The public read-side projector (`projectFilecoinPublicMetadata`)
 * lives in the provider-neutral
 * `src/storage/filecoin-public-metadata.ts` module and its tests
 * sit in `src/storage/__tests__/filecoin-public-metadata.test.ts`;
 * the route + service layer reads from that shared module so the
 * the provider-boundary import-boundary invariant stays clean.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_FILECOIN_METADATA_KEYS,
  FILECOIN_METADATA_DENYLIST,
  FILECOIN_METADATA_RESERVED_PREFIXES,
  buildFilecoinMetadata,
} from '../metadata.js';

describe('buildFilecoinMetadata — allowlist projection (≤5 piece entries)', () => {
  it('keeps up to MAX_KEYS_PER_PIECE allowlisted keys with scalar values', () => {
    const out = buildFilecoinMetadata({
      artifact_id: 'a-1',
      storage_profile_id: 'p-2',
      content_type: 'application/pdf',
      stored_hash: 'h'.repeat(64),
      codec_name: 'aes_gcm',
    });
    expect(out).toEqual({
      artifact_id: 'a-1',
      storage_profile_id: 'p-2',
      content_type: 'application/pdf',
      stored_hash: 'h'.repeat(64),
      codec_name: 'aes_gcm',
    });
  });

  it('silently drops unknown keys (non-denylisted, non-reserved)', () => {
    const out = buildFilecoinMetadata({
      artifact_id: 'a-1',
      mystery_extra: 'value',
      random: 42,
    });
    expect(out).toEqual({ artifact_id: 'a-1' });
  });

  it('throws when the caller supplies more than 5 allowlisted keys (Synapse MAX_KEYS_PER_PIECE)', () => {
    expect(() =>
      buildFilecoinMetadata({
        artifact_id: 'a',
        storage_profile_id: 'b',
        content_type: 'c',
        stored_hash: 'd',
        codec_name: 'e',
        codec_version: 1, // 6th allowlisted entry → over the cap
      }),
    ).toThrow(/MAX_KEYS_PER_PIECE/);
  });

  it('rejects string values longer than 128 chars (Synapse MAX_VALUE_LENGTH)', () => {
    expect(() =>
      buildFilecoinMetadata({ stored_hash: 'x'.repeat(129) }),
    ).toThrow(/MAX_VALUE_LENGTH/);
    expect(() =>
      buildFilecoinMetadata({ stored_hash: 'x'.repeat(128) }),
    ).not.toThrow();
  });

  it('matches the allowlist constant snapshot (8 candidate keys; ≤5 may ship per upload)', () => {
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
});

describe('buildFilecoinMetadata — denylist + reserved-prefix rejection', () => {
  it.each(FILECOIN_METADATA_DENYLIST)('throws on denylisted key %s', (key) => {
    expect(() => buildFilecoinMetadata({ [key]: 'whatever' })).toThrow(/denylisted/);
  });

  it.each([
    ['atomicmemory.tenant', 'atomicmemory.'],
    ['synapse.deal', 'synapse.'],
    ['filecoin.copy', 'filecoin.'],
    ['_internal', '_'],
  ])('throws on key %p (reserved prefix %p)', (key, prefix) => {
    expect(() => buildFilecoinMetadata({ [key]: 'x' })).toThrow(prefix);
  });

  it('exposes the reserved-prefix constant', () => {
    expect([...FILECOIN_METADATA_RESERVED_PREFIXES]).toEqual([
      'atomicmemory.',
      'synapse.',
      'filecoin.',
      '_',
    ]);
  });
});

describe('buildFilecoinMetadata — value-type rejection', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', [1, 2]],
    ['nested object', { k: 'v' }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects non-scalar value (%s)', (_label, value) => {
    expect(() => buildFilecoinMetadata({ artifact_id: value })).toThrow(/scalar/);
  });
});
