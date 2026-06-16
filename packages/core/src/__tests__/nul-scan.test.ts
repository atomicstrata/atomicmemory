/**
 * @file Unit tests for the shared NUL-byte scanner (`src/nul-scan.ts`). NUL is
 * built via fromCharCode so this source file carries no raw NUL byte.
 */

import { describe, expect, it } from 'vitest';
import { scanForNul, containsNoNul } from '../nul-scan.js';

const NUL = String.fromCharCode(0);

describe('containsNoNul', () => {
  it('is false for a string with a NUL and true otherwise', () => {
    expect(containsNoNul(`a${NUL}b`)).toBe(false);
    expect(containsNoNul('clean')).toBe(true);
  });
});

describe('scanForNul', () => {
  it('finds a NUL in a top-level string', () => {
    expect(scanForNul(`a${NUL}`)).toBe('nul');
  });

  it('finds a NUL nested in an array', () => {
    expect(scanForNul(['ok', ['deeper', `bad${NUL}`]])).toBe('nul');
  });

  it('finds a NUL in an object VALUE', () => {
    expect(scanForNul({ a: { b: `v${NUL}` } })).toBe('nul');
  });

  it('finds a NUL in an object KEY (reaches a JSONB column)', () => {
    expect(scanForNul({ [`k${NUL}`]: 'v' })).toBe('nul');
  });

  it('skips Buffer values so binary uploads are not treated as text', () => {
    expect(scanForNul({ body: Buffer.from([0x01, 0x00, 0x02]) })).toBe('clean');
  });

  it('returns clean for NUL-free nested data and non-string scalars', () => {
    expect(scanForNul({ a: ['x', { b: 1, c: 'y', z: null }] })).toBe('clean');
  });

  it('returns too-deep past the depth bound instead of recursing unboundedly', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 50; i += 1) nested = { next: nested };
    expect(scanForNul(nested, 10)).toBe('too-deep');
  });
});
