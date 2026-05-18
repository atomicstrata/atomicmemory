/**
 * Construct the `RawContentCodec` instance the upload service wraps
 * around `RawContentStore.put()` / `get()` (Phase 5 wiring).
 *
 * The factory is composition-root code: validates the configured
 * codec/keyring is consistent (config validation already enforced this
 * at startup; this is defense-in-depth) and returns the codec
 * implementation. Returns the noop codec for `RAW_CONTENT_CODEC='none'`
 * — bytes pass through unchanged but a `{ name: 'none', version: 1 }`
 * sidecar still lands in `raw_storage_metadata.codec` so the read
 * path branches deterministically.
 */

import type { RuntimeConfig } from '../config.js';
import { NoopRawContentCodec } from './codecs/noop-codec.js';
import { AesGcmRawContentCodec } from './codecs/aes-gcm-codec.js';
import type { RawContentCodec } from './raw-content-codec.js';

type CodecConfig = Pick<
  RuntimeConfig,
  'rawContentCodec' | 'rawContentCodecKeys' | 'rawContentCodecActiveKeyId'
>;

export function buildRawContentCodec(cfg: CodecConfig): RawContentCodec {
  if (cfg.rawContentCodec === 'none') {
    return new NoopRawContentCodec();
  }
  if (!cfg.rawContentCodecActiveKeyId) {
    throw new Error(
      "buildRawContentCodec: RAW_CONTENT_CODEC='aes_gcm' requires RAW_CONTENT_CODEC_ACTIVE_KEY_ID.",
    );
  }
  const keys = Array.from(cfg.rawContentCodecKeys.entries()).map(([keyId, key]) => ({
    keyId,
    key,
  }));
  if (keys.length === 0) {
    throw new Error(
      "buildRawContentCodec: RAW_CONTENT_CODEC='aes_gcm' requires a non-empty RAW_CONTENT_CODEC_KEYS ring.",
    );
  }
  return new AesGcmRawContentCodec({
    keys,
    activeKeyId: cfg.rawContentCodecActiveKeyId,
  });
}
