/**
 * AES-256-GCM content codec backed by a keyring. `encode` picks the
 * caller-provided ACTIVE key and writes `{ name, version, key_id,
 * nonce, tag, encoded_content_hash, encoded_size_bytes }` into the
 * sidecar metadata. `decode` reads `key_id` from the metadata, looks up
 * THAT key in the ring, and runs `createDecipheriv` — wrong key, wrong
 * nonce, or tampered ciphertext all surface as
 * `RawContentCodecError` via the GCM auth tag.
 *
 * Keys are 32 bytes (AES-256). Nonces are 12 random bytes per encode
 * (the GCM IV — must be unique per (key, message) pair). Tags are 16
 * bytes (the default GCM auth tag size).
 *
 * Encoding stores diagnostic context (`encoded_content_hash`,
 * `encoded_size_bytes`) under the codec sidecar — these never reach
 * the wire (rev-6 §6 redaction allowlist), they exist so ops can
 * correlate the bytes the adapter saw with the row's plaintext
 * `content_hash`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type {
  InternalRawContentCodecMetadata,
  RawContentCodec,
  RawContentCodecDecodeInput,
  RawContentCodecDecodeResult,
  RawContentCodecEncodeInput,
  RawContentCodecEncodeResult,
} from '../raw-content-codec.js';
import {
  RawContentCodecError,
  RawContentCodecKeyNotFoundError,
} from '../raw-content-codec.js';

const AES_GCM_CODEC_VERSION = 1;
const AES_GCM_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

/**
 * Keyring entry: parsed 32-byte key paired with its operator-assigned
 * id. The id is what ends up in `raw_storage_metadata.codec.key_id`
 * so future decodes can find the right key even after rotation.
 */
export interface AesGcmKeyringEntry {
  keyId: string;
  key: Buffer;
}

/** Operator-provided keyring config consumed by the codec constructor. */
export interface AesGcmKeyringConfig {
  /** Every key the codec can decode with. MUST contain `activeKeyId`. */
  keys: ReadonlyArray<AesGcmKeyringEntry>;
  /** Which key id to use for new `encode` calls. */
  activeKeyId: string;
}

function assertKeyBytes(keyId: string, key: Buffer): void {
  if (key.length !== AES_GCM_KEY_BYTES) {
    throw new RawContentCodecError(
      `AES-256-GCM key '${keyId}' must be exactly ${AES_GCM_KEY_BYTES} bytes (got ${key.length}).`,
    );
  }
}

export class AesGcmRawContentCodec implements RawContentCodec {
  readonly name = 'aes_gcm' as const;
  private readonly ring: Map<string, Buffer>;
  private readonly activeKeyId: string;

  constructor(config: AesGcmKeyringConfig) {
    if (config.keys.length === 0) {
      throw new RawContentCodecError('AES-GCM codec requires at least one key in the ring.');
    }
    this.ring = new Map();
    for (const entry of config.keys) {
      assertKeyBytes(entry.keyId, entry.key);
      if (this.ring.has(entry.keyId)) {
        throw new RawContentCodecError(`Duplicate keyId '${entry.keyId}' in keyring.`);
      }
      this.ring.set(entry.keyId, entry.key);
    }
    if (!this.ring.has(config.activeKeyId)) {
      throw new RawContentCodecError(
        `Active key id '${config.activeKeyId}' is not present in the keyring.`,
      );
    }
    this.activeKeyId = config.activeKeyId;
  }

  async encode(input: RawContentCodecEncodeInput): Promise<RawContentCodecEncodeResult> {
    const key = this.ring.get(this.activeKeyId);
    if (!key) {
      throw new RawContentCodecKeyNotFoundError(this.activeKeyId);
    }
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(input.body), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encodedHash = createHash('sha256').update(ciphertext).digest('hex');
    const metadata: InternalRawContentCodecMetadata = {
      name: 'aes_gcm',
      version: AES_GCM_CODEC_VERSION,
      key_id: this.activeKeyId,
      nonce: nonce.toString('base64url'),
      tag: tag.toString('base64url'),
      encoded_content_hash: encodedHash,
      encoded_size_bytes: ciphertext.length,
    };
    return { body: ciphertext, metadata };
  }

  async decode(input: RawContentCodecDecodeInput): Promise<RawContentCodecDecodeResult> {
    const { metadata } = input;
    if (metadata.name !== 'aes_gcm') {
      throw new RawContentCodecError(
        `AES-GCM codec cannot decode metadata.name='${metadata.name}'.`,
      );
    }
    if (!metadata.key_id) {
      throw new RawContentCodecError('AES-GCM codec metadata is missing key_id.');
    }
    const key = this.ring.get(metadata.key_id);
    if (!key) {
      throw new RawContentCodecKeyNotFoundError(metadata.key_id);
    }
    const nonce = decodeBase64Url(metadata.nonce, 'nonce', AES_GCM_NONCE_BYTES);
    const tag = decodeBase64Url(metadata.tag, 'tag', AES_GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([decipher.update(input.body), decipher.final()]);
      return { body: plaintext };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RawContentCodecError(`AES-GCM decode failed (auth tag mismatch or tamper): ${reason}`);
    }
  }
}

function decodeBase64Url(value: string | undefined, field: string, expectedBytes: number): Buffer {
  if (!value) {
    throw new RawContentCodecError(`AES-GCM codec metadata is missing '${field}'.`);
  }
  const buf = Buffer.from(value, 'base64url');
  if (buf.length !== expectedBytes) {
    throw new RawContentCodecError(
      `AES-GCM codec metadata '${field}' has ${buf.length} bytes; expected ${expectedBytes}.`,
    );
  }
  return buf;
}
