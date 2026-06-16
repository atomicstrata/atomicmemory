/**
 * @file Unit tests for NUL rejection in `validateArtifactMetadata`. This is the
 * shared validator both storage metadata paths run through — the pointer JSON
 * body AND the managed `X-AtomicMemory-Metadata` header (which bypasses the
 * request-boundary body guard). A NUL in a key or string value passes the
 * type/size gates but 500s at the JSONB column, so it must be rejected here.
 * NUL is built via fromCharCode so this source file carries no raw NUL byte.
 */

import { describe, expect, it } from 'vitest';
import { validateArtifactMetadata } from '../storage-service.js';
import { InvalidArtifactMetadataError } from '../storage-service-errors.js';

const NUL = String.fromCharCode(0);

describe('validateArtifactMetadata NUL rejection', () => {
  it('rejects a NUL in a metadata string value', () => {
    expect(() => validateArtifactMetadata({ k: `v${NUL}` })).toThrow(InvalidArtifactMetadataError);
  });

  it('rejects a NUL in a metadata key', () => {
    expect(() => validateArtifactMetadata({ [`k${NUL}`]: 'v' })).toThrow(InvalidArtifactMetadataError);
  });

  it('still accepts clean metadata, including non-string scalars', () => {
    expect(validateArtifactMetadata({ a: 'x', n: 1, b: true })).toEqual({ a: 'x', n: 1, b: true });
  });
});
