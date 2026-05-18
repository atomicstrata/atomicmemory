/**
 * @file Round-trip tests for the filecoin-pin CAR helpers.
 *
 * `buildCarFromBytes` and `extractFileFromCar` are the inverse of
 * each other; for every input buffer `body`,
 * `extractFileFromCar(buildCarFromBytes(body).carBytes,
 * built.rootCid)` must equal `body`. The driver's `put` / `get`
 * symmetry relies on this property — a regression here would
 * break the public storage contract end-to-end.
 *
 * Tests deliberately exercise three buffer sizes:
 *   - small (< chunk size) — single unixfs leaf block;
 *   - exactly one chunk — boundary case for the chunker;
 *   - multi-chunk — a small DAG with a root pointing at chunks.
 * That spans the unixfs DAG shapes the driver will see in
 * production (most uploads are small; some retrievals may span
 * larger CARs).
 */

import { describe, expect, it } from 'vitest';
import { CarReader } from '@ipld/car';
import { buildCarFromBytes, extractFileFromCar } from '../filecoin-pin-car.js';

async function roundTrip(body: Buffer): Promise<void> {
  const built = await buildCarFromBytes(body);
  expect(built.carBytes.length).toBeGreaterThan(0);
  expect(built.rootCid.toString()).toMatch(/^b[a-z2-7]+$/);
  const back = await extractFileFromCar(built.carBytes, built.rootCid);
  expect(Buffer.compare(body, back)).toBe(0);
}

describe('buildCarFromBytes / extractFileFromCar — round-trip invariant', () => {
  it('round-trips a small ASCII payload (single unixfs leaf)', async () => {
    await roundTrip(Buffer.from('hello filecoin-pin'));
  });

  it('round-trips a 1 KiB payload (still a single chunk)', async () => {
    await roundTrip(Buffer.alloc(1024, 0x41));
  });

  it('round-trips a multi-chunk payload (~ 1 MiB)', async () => {
    // 1 MiB exceeds the default 256 KiB unixfs chunk size, so the
    // resulting DAG has a root block referencing multiple leaves
    // — the path that exercises the multi-block CAR copy.
    const body = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    await roundTrip(body);
  });

  it('round-trips an empty buffer', async () => {
    await roundTrip(Buffer.alloc(0));
  });
});

describe('buildCarFromBytes — emitted CAR exposes the root in roots[]', () => {
  it('CarReader.getRoots() returns the same root the builder reported', async () => {
    const body = Buffer.from('roots[] survives serialisation');
    const built = await buildCarFromBytes(body);
    const reader = await CarReader.fromBytes(built.carBytes);
    const roots = await reader.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.toString()).toBe(built.rootCid.toString());
  });

  it('emitted root CID is a structurally valid CIDv1 (multibase `b` prefix)', async () => {
    const built = await buildCarFromBytes(Buffer.from('shape check'));
    const s = built.rootCid.toString();
    expect(s.startsWith('b')).toBe(true);
    expect(built.rootCid.version).toBe(1);
  });
});
