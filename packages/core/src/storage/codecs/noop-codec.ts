/**
 * Pass-through codec: bytes go in and bytes come out unchanged. Used
 * when `RAW_CONTENT_CODEC=none` — the immediate-provider default for
 * `local_fs` / `s3` deployments where operator-level encryption isn't
 * needed (or is handled below the application layer by the provider).
 *
 * Round-trips a `name + version` sidecar so the read path can branch on
 * `metadata.codec.name === 'none'` deterministically rather than
 * inferring "no codec" from a missing key.
 */

import type {
  RawContentCodec,
  RawContentCodecDecodeInput,
  RawContentCodecDecodeResult,
  RawContentCodecEncodeInput,
  RawContentCodecEncodeResult,
} from '../raw-content-codec.js';

const NOOP_CODEC_VERSION = 1;

export class NoopRawContentCodec implements RawContentCodec {
  readonly name = 'none' as const;

  async encode(input: RawContentCodecEncodeInput): Promise<RawContentCodecEncodeResult> {
    return {
      body: input.body,
      metadata: { name: 'none', version: NOOP_CODEC_VERSION },
    };
  }

  async decode(input: RawContentCodecDecodeInput): Promise<RawContentCodecDecodeResult> {
    return { body: input.body };
  }
}
