/**
 * @file Filecoin provider-internal metadata allowlist + denylist.
 *
 * The public projector lives in
 * `src/storage/filecoin-public-metadata.ts` so routes / services
 * don't have to import `providers/filecoin/*` directly. What
 * remains here is provider-internal:
 *
 *   - `buildFilecoinMetadata(input)` produces the closed-shape
 *     Synapse piece-metadata envelope upload calls may pass through.
 *     Synapse's `METADATA_LIMITS.MAX_KEYS_PER_PIECE`
 *     is 5 (per docs.filecoin.cloud/reference/filoz/synapse-core/
 *     utils/variables/metadata_limits/); this builder enforces the
 *     cap so an over-allowed envelope cannot reach Synapse and
 *     fail mid-upload. Key length is also capped at the documented
 *     32 chars and string values at 128 chars.
 *   - The allowlist, denylist, and reserved-prefix constants the
 *     upload + central config validators share (config.ts's
 *     DATA_SET_METADATA validation reads from the same constants
 *     and applies the dataset-side limits 10 / 32 / 128).
 *
 * Upload-side safety rule: this module NEVER lets private keys,
 * wallet addresses, payment-rail state, signed requests, auth
 * headers, UCAN proofs, raw Synapse responses, or any other key on
 * the denylist reach the provider. Reserved prefixes
 * (`atomicmemory.`, `synapse.`, `filecoin.`, `_`) are rejected as
 * caller-supplied keys.
 *
 * Read-side projection — what survives onto the public wire when
 * reading `raw_documents.raw_storage_metadata.filecoin` back — is
 * the shared module's job (`projectFilecoinPublicMetadata`). The
 * internal `copies: [{ provider_id, status }]` shape flattens to
 * scalar `copy_count` / `provider_ids` / `copy_statuses` over
 * there.
 */

export const ALLOWED_FILECOIN_METADATA_KEYS = [
  'artifact_id',
  'storage_profile_id',
  'content_type',
  'stored_hash',
  'codec_name',
  'codec_version',
  'codec_key_id',
  'source_kind',
] as const;

export type AllowedFilecoinMetadataKey = (typeof ALLOWED_FILECOIN_METADATA_KEYS)[number];

/**
 * Closed denylist — keys / shapes `buildFilecoinMetadata` MUST
 * reject if a caller (or a stray test fixture) tries to push them
 * onto a Filecoin upload. The list pins items that, if leaked
 * through `provider_metadata` or `data_set_metadata`, would expose
 * secrets or sensitive operational state.
 */
export const FILECOIN_METADATA_DENYLIST = [
  'private_key',
  'wallet_address',
  'payment_rail',
  'rail_id',
  'signed_request',
  'authorization',
  'auth_header',
  'ucan_proof',
  'synapse_response',
  'raw_synapse_payload',
] as const;

export const FILECOIN_METADATA_RESERVED_PREFIXES = [
  'atomicmemory.',
  'synapse.',
  'filecoin.',
  '_',
] as const;

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_FILECOIN_METADATA_KEYS);
const DENY_KEY_SET: ReadonlySet<string> = new Set(FILECOIN_METADATA_DENYLIST);

/**
 * Mirrored from Synapse's `METADATA_LIMITS` (per
 * docs.filecoin.cloud/reference/filoz/synapse-core/utils/variables/
 * metadata_limits/). The dataset-side limits (10 keys) live in
 * `./config.ts`; the piece-side limits (5 keys) live here because
 * `buildFilecoinMetadata` produces the per-piece envelope.
 */
const MAX_PIECE_METADATA_KEYS = 5;
const MAX_PIECE_METADATA_KEY_LENGTH = 32;
const MAX_PIECE_METADATA_VALUE_LENGTH = 128;

/**
 * Scalar leaf-type set accepted by `buildFilecoinMetadata`.
 * Matches the existing `ArtifactMetadata` write-side contract
 * (string | finite number | boolean).
 */
export type FilecoinMetadataLeaf = string | number | boolean;

/**
 * Input to `buildFilecoinMetadata`: any caller-supplied bag of
 * metadata. Keys are normalized to the allowlist before any I/O;
 * non-leaf values (arrays, objects, null, undefined) cause the
 * call to throw so callers cannot quietly leak shape.
 */
export type FilecoinMetadataInput = Record<string, unknown>;

/** Projected closed-shape envelope ready to ship to the provider. */
export type FilecoinMetadataEnvelope = Readonly<
  Partial<Record<AllowedFilecoinMetadataKey, FilecoinMetadataLeaf>>
>;

/**
 * Project caller-supplied metadata down to the allowlisted closed
 * envelope, enforcing Synapse's per-piece limits (≤5 entries, ≤32
 * char keys, ≤128 char string values). Throws on denylisted keys,
 * reserved-prefix keys, non-scalar values, over-long strings, or
 * an output that would exceed the 5-key cap. Unknown (non-
 * allowlisted, non-denylisted) keys are silently dropped — fail-
 * open on inputs we don't understand would surface secrets on a
 * future contributor's keystroke.
 */
export function buildFilecoinMetadata(input: FilecoinMetadataInput): FilecoinMetadataEnvelope {
  const out: Partial<Record<AllowedFilecoinMetadataKey, FilecoinMetadataLeaf>> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    rejectReservedOrDeniedKey(key);
    if (!ALLOWED_KEY_SET.has(key)) continue;
    if (key.length > MAX_PIECE_METADATA_KEY_LENGTH) {
      throw new Error(
        `Filecoin metadata key '${key}' exceeds Synapse MAX_KEY_LENGTH ` +
          `(${MAX_PIECE_METADATA_KEY_LENGTH}).`,
      );
    }
    if (count >= MAX_PIECE_METADATA_KEYS) {
      throw new Error(
        `Filecoin piece metadata would exceed Synapse MAX_KEYS_PER_PIECE ` +
          `(${MAX_PIECE_METADATA_KEYS}). Drop entries before calling buildFilecoinMetadata.`,
      );
    }
    out[key as AllowedFilecoinMetadataKey] = coerceLeaf(key, value);
    count += 1;
  }
  return out;
}

function rejectReservedOrDeniedKey(key: string): void {
  for (const prefix of FILECOIN_METADATA_RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw new Error(
        `Filecoin metadata key '${key}' uses reserved prefix '${prefix}'.`,
      );
    }
  }
  if (DENY_KEY_SET.has(key.toLowerCase())) {
    throw new Error(`Filecoin metadata key '${key}' is denylisted.`);
  }
}

function coerceLeaf(key: string, value: unknown): FilecoinMetadataLeaf {
  if (typeof value === 'string') {
    if (value.length > MAX_PIECE_METADATA_VALUE_LENGTH) {
      throw new Error(
        `Filecoin metadata value for '${key}' exceeds Synapse ` +
          `MAX_VALUE_LENGTH (${MAX_PIECE_METADATA_VALUE_LENGTH}, got ${value.length}).`,
      );
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  throw new Error(
    `Filecoin metadata value for '${key}' must be a scalar ` +
      '(string, finite number, or boolean).',
  );
}
