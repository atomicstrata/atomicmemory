/**
 * Fail-closed parsers for decode-cap and related integer env vars.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseBoundedPositiveIntEnv, parsePositiveIntEnv } from '../env.js';

const NAME = 'AUDN_MAX_TOKENS';
const UNBOUNDED_NAME = 'RAW_UPLOAD_MAX_BYTES';

afterEach(() => {
  delete process.env[NAME];
  delete process.env[UNBOUNDED_NAME];
});

describe('parseBoundedPositiveIntEnv', () => {
  it('accepts a whole decimal integer', () => {
    process.env[NAME] = '128';
    expect(parseBoundedPositiveIntEnv(NAME, 2048, 4096)).toBe(128);
  });

  it.each(['128junk', '1.5', '1e3', '0', '-1', 'oops', '08'])(
    'rejects malformed value %s',
    (value) => {
      process.env[NAME] = value;
      expect(() => parseBoundedPositiveIntEnv(NAME, 2048, 4096)).toThrow(
        'AUDN_MAX_TOKENS must be a positive integer',
      );
    },
  );

  it('rejects values above the documented upper bound', () => {
    process.env[NAME] = '4097';
    expect(() => parseBoundedPositiveIntEnv(NAME, 2048, 4096)).toThrow(
      'AUDN_MAX_TOKENS must be at most 4096',
    );
  });
});

describe('parsePositiveIntEnv', () => {
  it('accepts Number.MAX_SAFE_INTEGER', () => {
    process.env[UNBOUNDED_NAME] = String(Number.MAX_SAFE_INTEGER);
    expect(parsePositiveIntEnv(UNBOUNDED_NAME, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects overflow that Number() would coerce to Infinity', () => {
    process.env[UNBOUNDED_NAME] = '9'.repeat(400);
    expect(() => parsePositiveIntEnv(UNBOUNDED_NAME, 1)).toThrow(
      'RAW_UPLOAD_MAX_BYTES must be a positive integer',
    );
  });

  it('rejects Number.MAX_SAFE_INTEGER + 1', () => {
    process.env[UNBOUNDED_NAME] = String(Number.MAX_SAFE_INTEGER + 1);
    expect(() => parsePositiveIntEnv(UNBOUNDED_NAME, 1)).toThrow(
      'RAW_UPLOAD_MAX_BYTES must be a positive integer',
    );
  });
});
