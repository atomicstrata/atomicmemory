/**
 * @file Schema tests for the storage pointer body — NUL-byte rejection on the
 * fields that reach Postgres (text columns + JSONB metadata). `/v1/storage`
 * owns mixed JSON/raw parsing and is not under a `rejectNulInBody` mount, so the
 * rejection has to live in the schema. NUL is built via fromCharCode so this
 * source file carries no raw NUL byte.
 */

import { describe, expect, it } from 'vitest';
import { PutPointerBodySchema } from '../storage-schemas';

const NUL = String.fromCharCode(0);
const base = { mode: 'pointer' as const, uri: 'ipfs://cid', content_type: 'text/plain' };

describe('PutPointerBodySchema rejects NUL bytes (storage reaches Postgres text + JSONB)', () => {
  it('rejects a NUL byte in uri / content_type / content_hash', () => {
    expect(PutPointerBodySchema.safeParse({ ...base, uri: `ipfs://${NUL}` }).success).toBe(false);
    expect(PutPointerBodySchema.safeParse({ ...base, content_type: `text/${NUL}` }).success).toBe(false);
    expect(PutPointerBodySchema.safeParse({ ...base, content_hash: `sha256${NUL}` }).success).toBe(false);
  });

  it('rejects a NUL byte in a metadata value', () => {
    expect(PutPointerBodySchema.safeParse({ ...base, metadata: { k: `v${NUL}` } }).success).toBe(false);
  });

  it('rejects a NUL byte in a metadata key', () => {
    expect(PutPointerBodySchema.safeParse({ ...base, metadata: { [`k${NUL}`]: 'v' } }).success).toBe(false);
  });

  it('still accepts a clean pointer body, including an empty-string metadata value', () => {
    const r = PutPointerBodySchema.safeParse({ ...base, metadata: { k: '', n: 1, b: true } });
    expect(r.success).toBe(true);
  });
});
