/**
 * Round-trip + tamper + key-rotation tests for the AES-GCM codec
 * (Phase 1 of the Filecoin end-to-end plan). The noop codec is also
 * tested for shape — it has no auth surface but its `name + version`
 * sidecar must round-trip so the read path can branch on the codec
 * deterministically.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  RawContentCodecError,
  RawContentCodecKeyNotFoundError,
} from '../raw-content-codec.js';
import { NoopRawContentCodec } from '../codecs/noop-codec.js';
import { AesGcmRawContentCodec } from '../codecs/aes-gcm-codec.js';

function makeKey(): Buffer {
  return randomBytes(32);
}

describe('NoopRawContentCodec', () => {
  it('encode returns bytes unchanged with name=none sidecar', async () => {
    const codec = new NoopRawContentCodec();
    const body = Buffer.from('plain bytes');
    const result = await codec.encode({ body });
    expect(result.body).toEqual(body);
    expect(result.metadata).toEqual({ name: 'none', version: 1 });
  });

  it('decode returns bytes unchanged', async () => {
    const codec = new NoopRawContentCodec();
    const body = Buffer.from('plain bytes');
    const result = await codec.decode({ body, metadata: { name: 'none', version: 1 } });
    expect(result.body).toEqual(body);
  });
});

describe('AesGcmRawContentCodec — basics', () => {
  it('round-trips a random binary buffer with a one-key ring', async () => {
    const keyId = 'v1';
    const key = makeKey();
    const codec = new AesGcmRawContentCodec({ keys: [{ keyId, key }], activeKeyId: keyId });
    const body = randomBytes(1024);
    const encoded = await codec.encode({ body });
    expect(encoded.body.length).toBe(body.length);
    expect(encoded.body.equals(body)).toBe(false);
    expect(encoded.metadata.name).toBe('aes_gcm');
    expect(encoded.metadata.version).toBe(1);
    expect(encoded.metadata.key_id).toBe(keyId);
    expect(typeof encoded.metadata.nonce).toBe('string');
    expect(typeof encoded.metadata.tag).toBe('string');
    expect(encoded.metadata.encoded_size_bytes).toBe(encoded.body.length);
    expect(typeof encoded.metadata.encoded_content_hash).toBe('string');
    const decoded = await codec.decode({ body: encoded.body, metadata: encoded.metadata });
    expect(decoded.body.equals(body)).toBe(true);
  });

  it('rejects an empty keyring', () => {
    expect(() => new AesGcmRawContentCodec({ keys: [], activeKeyId: 'v1' })).toThrow(
      RawContentCodecError,
    );
  });

  it('rejects active key id absent from the ring', () => {
    expect(
      () => new AesGcmRawContentCodec({ keys: [{ keyId: 'v1', key: makeKey() }], activeKeyId: 'v2' }),
    ).toThrow(RawContentCodecError);
  });

  it('rejects keys not exactly 32 bytes', () => {
    expect(
      () =>
        new AesGcmRawContentCodec({
          keys: [{ keyId: 'v1', key: Buffer.alloc(16) }],
          activeKeyId: 'v1',
        }),
    ).toThrow(RawContentCodecError);
  });

  it('rejects duplicate key ids in the ring', () => {
    expect(
      () =>
        new AesGcmRawContentCodec({
          keys: [
            { keyId: 'v1', key: makeKey() },
            { keyId: 'v1', key: makeKey() },
          ],
          activeKeyId: 'v1',
        }),
    ).toThrow(RawContentCodecError);
  });
});

describe('AesGcmRawContentCodec — tamper + wrong-key', () => {
  it('throws when ciphertext is tampered', async () => {
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: makeKey() }],
      activeKeyId: 'v1',
    });
    const encoded = await codec.encode({ body: Buffer.from('secret') });
    const tampered = Buffer.from(encoded.body);
    tampered[0] = tampered[0] ^ 0xff;
    await expect(codec.decode({ body: tampered, metadata: encoded.metadata })).rejects.toThrow(
      RawContentCodecError,
    );
  });

  it('throws when the auth tag is wrong (rebuilt with bad tag)', async () => {
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: makeKey() }],
      activeKeyId: 'v1',
    });
    const encoded = await codec.encode({ body: Buffer.from('secret') });
    const badMeta = { ...encoded.metadata, tag: Buffer.alloc(16, 0).toString('base64url') };
    await expect(codec.decode({ body: encoded.body, metadata: badMeta })).rejects.toThrow(
      RawContentCodecError,
    );
  });

  it('throws when decoding with the wrong key in a fresh codec', async () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const codecA = new AesGcmRawContentCodec({ keys: [{ keyId: 'v1', key: keyA }], activeKeyId: 'v1' });
    const codecB = new AesGcmRawContentCodec({ keys: [{ keyId: 'v1', key: keyB }], activeKeyId: 'v1' });
    const encoded = await codecA.encode({ body: Buffer.from('secret') });
    await expect(codecB.decode({ body: encoded.body, metadata: encoded.metadata })).rejects.toThrow(
      RawContentCodecError,
    );
  });
});

describe('AesGcmRawContentCodec — keyring + rotation', () => {
  it('encodes with the active key id and stamps it in the metadata', async () => {
    const codec = new AesGcmRawContentCodec({
      keys: [
        { keyId: 'old', key: makeKey() },
        { keyId: 'new', key: makeKey() },
      ],
      activeKeyId: 'new',
    });
    const encoded = await codec.encode({ body: Buffer.from('hello') });
    expect(encoded.metadata.key_id).toBe('new');
  });

  it('rotation: encode with old, rotate active to new, decode old row via stored key_id', async () => {
    const keyOld = makeKey();
    const keyNew = makeKey();
    const codecPreRotation = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: keyOld }],
      activeKeyId: 'v1',
    });
    const encoded = await codecPreRotation.encode({ body: Buffer.from('rotate-me') });
    // Operator adds key v2, flips active to v2; key v1 stays in the ring.
    const codecPostRotation = new AesGcmRawContentCodec({
      keys: [
        { keyId: 'v1', key: keyOld },
        { keyId: 'v2', key: keyNew },
      ],
      activeKeyId: 'v2',
    });
    const decoded = await codecPostRotation.decode({ body: encoded.body, metadata: encoded.metadata });
    expect(decoded.body.equals(Buffer.from('rotate-me'))).toBe(true);
  });

  it('rotation: removing the old key from the ring raises KeyNotFoundError on decode', async () => {
    const keyOld = makeKey();
    const keyNew = makeKey();
    const codecPreRotation = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: keyOld }],
      activeKeyId: 'v1',
    });
    const encoded = await codecPreRotation.encode({ body: Buffer.from('lost-key') });
    const codecPostRotation = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v2', key: keyNew }],
      activeKeyId: 'v2',
    });
    await expect(
      codecPostRotation.decode({ body: encoded.body, metadata: encoded.metadata }),
    ).rejects.toBeInstanceOf(RawContentCodecKeyNotFoundError);
  });

  it('multi-key ring: both keys are decodable; new writes go to active', async () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const ring = {
      keys: [
        { keyId: 'kA', key: keyA },
        { keyId: 'kB', key: keyB },
      ],
      activeKeyId: 'kB',
    };
    const codec = new AesGcmRawContentCodec(ring);
    // Encode with active 'kB'.
    const encB = await codec.encode({ body: Buffer.from('hello-B') });
    expect(encB.metadata.key_id).toBe('kB');
    // Simulate an older row encoded with 'kA' by using a temporary codec
    // whose active is 'kA', then decode through the multi-key ring.
    const codecKA = new AesGcmRawContentCodec({ ...ring, activeKeyId: 'kA' });
    const encA = await codecKA.encode({ body: Buffer.from('hello-A') });
    expect(encA.metadata.key_id).toBe('kA');
    const decA = await codec.decode({ body: encA.body, metadata: encA.metadata });
    const decB = await codec.decode({ body: encB.body, metadata: encB.metadata });
    expect(decA.body.equals(Buffer.from('hello-A'))).toBe(true);
    expect(decB.body.equals(Buffer.from('hello-B'))).toBe(true);
  });

  it('decode throws when metadata.key_id is missing', async () => {
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: makeKey() }],
      activeKeyId: 'v1',
    });
    const encoded = await codec.encode({ body: Buffer.from('x') });
    const stripped = { name: encoded.metadata.name, version: encoded.metadata.version };
    await expect(codec.decode({ body: encoded.body, metadata: stripped })).rejects.toThrow(
      RawContentCodecError,
    );
  });

  it('decode throws when metadata.name is not aes_gcm', async () => {
    const codec = new AesGcmRawContentCodec({
      keys: [{ keyId: 'v1', key: makeKey() }],
      activeKeyId: 'v1',
    });
    await expect(
      codec.decode({
        body: Buffer.from('x'),
        metadata: { name: 'none', version: 1 },
      }),
    ).rejects.toThrow(RawContentCodecError);
  });
});
