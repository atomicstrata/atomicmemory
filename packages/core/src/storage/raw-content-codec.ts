/**
 * Content-codec layer that sits between the upload service and the
 * raw-content adapter (`RawContentStore`). A codec transforms the bytes
 * the caller asked us to store into the bytes the adapter actually
 * writes (`encode`), and is the inverse on read (`decode`).
 *
 * The motivating use case is Filecoin / IPFS, where the URI is
 * content-addressed: any third party who guesses or learns the CID can
 * pull the bytes from a public gateway. Plaintext storage there leaks
 * user data; encrypting at this layer means the CID commits to
 * ciphertext, while AtomicMemory still hashes the user's plaintext for
 * its own `raw_documents.content_hash` invariants.
 *
 * The codec also serves immediate providers (`local_fs`, `s3`) when an
 * operator wants encryption at rest above what the provider already
 * offers. The interface is unchanged — only the metadata sidecar (`name`,
 * `key_id`, `nonce`, `tag` for AES-GCM) tells the read path how to
 * reverse the transform.
 *
 * Keyring model: encode picks the operator-selected ACTIVE key; decode
 * reads `key_id` from the metadata and finds THAT key in the configured
 * ring. Operators rotate by adding a new key + flipping the active id —
 * old rows keep decoding via their stored `key_id`. Missing keys fail
 * loud (never silently fall back).
 */

/** Codec name carried in `raw_storage_metadata.codec.name`. */
export type RawContentCodecName = 'none' | 'aes_gcm';

/** Public, allowlisted codec metadata projected to the wire. */
export interface PublicRawContentCodecMetadata {
  name: RawContentCodecName;
  version: number;
}

/**
 * Internal codec metadata persisted on `raw_storage_metadata.codec`. The
 * AES-GCM codec also writes `key_id`, `nonce`, `tag`, and optionally
 * `encoded_content_hash` + `encoded_size_bytes` (rev-2 §5 — ops
 * diagnostics). `formatPublicMetadata` strips everything except the
 * `name` + `version` fields when emitting to the wire.
 */
export interface InternalRawContentCodecMetadata extends PublicRawContentCodecMetadata {
  key_id?: string;
  nonce?: string;
  tag?: string;
  encoded_content_hash?: string;
  encoded_size_bytes?: number;
}

export interface RawContentCodecEncodeInput {
  /** Plaintext bytes the caller asked us to store. */
  body: Buffer;
}

export interface RawContentCodecEncodeResult {
  /** Bytes the adapter actually writes (ciphertext for `aes_gcm`). */
  body: Buffer;
  /** Internal sidecar; the upload service merges this under `raw_storage_metadata.codec`. */
  metadata: InternalRawContentCodecMetadata;
}

export interface RawContentCodecDecodeInput {
  /** Bytes the adapter returned (ciphertext for `aes_gcm`). */
  body: Buffer;
  /** Sidecar read from `raw_storage_metadata.codec`. */
  metadata: InternalRawContentCodecMetadata;
}

export interface RawContentCodecDecodeResult {
  /** Plaintext bytes the original caller asked us to store. */
  body: Buffer;
}

/**
 * Codec interface. Implementations are stateless and must not mutate
 * the input buffer.
 */
export interface RawContentCodec {
  readonly name: RawContentCodecName;
  encode(input: RawContentCodecEncodeInput): Promise<RawContentCodecEncodeResult>;
  decode(input: RawContentCodecDecodeInput): Promise<RawContentCodecDecodeResult>;
}

/** Thrown for any codec-layer failure (bad input, tamper, key missing). */
export class RawContentCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawContentCodecError';
  }
}

/**
 * Thrown when `decode` reads a `key_id` that is not present in the
 * configured keyring. Loud-fail per the no-fallback policy — operators
 * must restore the key (or accept that the row's bytes are
 * unrecoverable) rather than the codec silently skipping.
 */
export class RawContentCodecKeyNotFoundError extends RawContentCodecError {
  readonly keyId: string;
  constructor(keyId: string) {
    super(
      `Codec key '${keyId}' is not configured in RAW_CONTENT_CODEC_KEYS. ` +
        'The decode cannot proceed; restore the key or treat the row as unrecoverable.',
    );
    this.name = 'RawContentCodecKeyNotFoundError';
    this.keyId = keyId;
  }
}
