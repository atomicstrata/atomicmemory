/**
 * Unit tests for the pointer-URI allowlist parser + validator.
 */

import { describe, expect, it } from 'vitest';
import {
  extractScheme,
  isAllowlistedPointerUri,
  parsePointerUriSchemes,
} from '../pointer-uri-allowlist.js';

describe('parsePointerUriSchemes', () => {
  it('returns the default safe set when the env var is undefined', () => {
    expect(parsePointerUriSchemes(undefined)).toEqual(['https', 's3', 'gs', 'ipfs']);
  });

  it('returns the default set when the env var is an empty string', () => {
    expect(parsePointerUriSchemes('  ')).toEqual(['https', 's3', 'gs', 'ipfs']);
  });

  it('parses a csv of known schemes including opt-in `http` and `local-fs`', () => {
    expect(parsePointerUriSchemes('https,http,local-fs')).toEqual(['https', 'http', 'local-fs']);
  });

  it('rejects an unknown scheme token at startup (fail-closed)', () => {
    expect(() => parsePointerUriSchemes('https,ftp')).toThrow(/Invalid RAW_STORAGE_POINTER_URI_SCHEMES/);
  });

  it('rejects duplicate entries', () => {
    expect(() => parsePointerUriSchemes('https,https')).toThrow(/Duplicate scheme/);
  });
});

describe('extractScheme', () => {
  it('extracts standard schemes', () => {
    expect(extractScheme('https://example.com/x')).toBe('https');
    expect(extractScheme('s3://bucket/key')).toBe('s3');
    expect(extractScheme('local-fs:///tmp/x')).toBe('local-fs');
  });

  it('lower-cases the scheme', () => {
    expect(extractScheme('HTTPS://example.com/x')).toBe('https');
  });

  it('returns null when the input is not a URI', () => {
    expect(extractScheme('not a uri')).toBeNull();
    expect(extractScheme('://no-scheme')).toBeNull();
  });
});

describe('isAllowlistedPointerUri', () => {
  it('admits a URI whose scheme is in the allowlist', () => {
    expect(isAllowlistedPointerUri('https://x', ['https', 's3'])).toBe(true);
  });

  it('rejects a URI whose scheme is not in the allowlist', () => {
    expect(isAllowlistedPointerUri('local-fs:///etc/passwd', ['https', 's3'])).toBe(false);
  });

  it('rejects a malformed URI', () => {
    expect(isAllowlistedPointerUri('not a uri', ['https'])).toBe(false);
  });
});
