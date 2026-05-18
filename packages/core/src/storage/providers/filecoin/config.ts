/**
 * @file Filecoin provider configuration.
 *
 * `parseFilecoinProviderConfig(env)` is the only env reader inside
 * `src/storage/providers/filecoin/*`. Central `src/config.ts`
 * collects `process.env` into a plain object and hands it to this
 * function; the provider module never reaches for `process.env`
 * itself, matching the workspace rule against direct env access in
 * business code.
 *
 * The cross-provider guard — rejecting any `RAW_STORAGE_FILECOIN_*`
 * environment variable when `RAW_STORAGE_PROVIDER` is non-filecoin —
 * lives in central `src/config.ts`. Reason:
 * `parseFilecoinProviderConfig` is only invoked when the provider IS
 * filecoin, so the cross-provider rejection has to fire at the
 * central seam to catch the misconfiguration. This module exports
 * `collectFilecoinProviderEnvKeys` so the central code can compute
 * which RAW_STORAGE_FILECOIN_* keys an operator set without
 * embedding the prefix string in two places.
 *
 * v1 credential model: operator-owned deployment credentials.
 * Storage-profile / per-org / per-user credential ownership is
 * deferred to a future release. `RAW_STORAGE_FILECOIN_PRIVATE_KEY` is
 * validated syntactically (`^0x[a-fA-F0-9]{64}$`) at startup. The
 * value is NEVER logged on rejection; no account derivation, no
 * chain, balance, and provider checks are handled by the readiness
 * probes in `./readiness.ts`.
 */

import {
  FILECOIN_METADATA_RESERVED_PREFIXES,
  FILECOIN_METADATA_DENYLIST,
} from './metadata.js';

export type FilecoinNetwork = 'calibration' | 'mainnet';
export type FilecoinDriver = 'synapse' | 'filecoin_pin';

/**
 * Parsed deployment-credential block. Constructed by
 * `parseFilecoinProviderConfig` at startup; held on the
 * runtime config and consumed by the Synapse client factory.
 */
export interface FilecoinProviderConfig {
  readonly driver: FilecoinDriver;
  readonly network: FilecoinNetwork;
  /** 0x-prefixed 32-byte hex string. Never logged on rejection. */
  readonly privateKey: string;
  readonly source: string;
  readonly withCdn: boolean;
  readonly providerIds: ReadonlyArray<string>;
  readonly copies: number | null;
  readonly dataSetMetadata: Readonly<Record<string, string | number | boolean>>;
  readonly maxUploadBytes: number | null;
  readonly minUploadBytes: number | null;
  readonly uploadTimeoutMs: number | null;
  readonly retrievalTimeoutMs: number | null;
}

/** Prefix shared by every `RAW_STORAGE_FILECOIN_*` environment variable. */
const FILECOIN_PROVIDER_ENV_PREFIX = 'RAW_STORAGE_FILECOIN_';

const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;
/**
 * DATA_SET_METADATA constraints mirror the Synapse SDK's
 * `METADATA_LIMITS` (docs.filecoin.cloud/reference/filoz/synapse-
 * core/utils/variables/metadata_limits/): MAX_KEYS_PER_DATASET=10,
 * MAX_KEY_LENGTH=32, MAX_VALUE_LENGTH=128. We enforce these
 * server-side so a misconfigured operator can't get past startup
 * with values Synapse would later reject. The key-charset
 * allowlist (`[A-Za-z0-9_.:-]+`) and the credential-shape rejection
 * are AtomicMemory-additional safety rails on top of the Synapse
 * limits.
 */
const MAX_METADATA_KEYS = 10;
const MAX_METADATA_KEY_LENGTH = 32;
const MAX_METADATA_VALUE_LENGTH = 128;
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/**
 * Patterns rejected in both keys AND string values. Matches credential
 * shapes (private keys, bearer tokens, UCAN proofs, signed requests,
 * authorization headers). Match is case-insensitive on the raw input.
 */
const CREDENTIAL_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /private[_-]?key/i,
  /\bbearer\b/i,
  /authorization/i,
  /\bucan\b/i,
  /signed[_-]?request/i,
  /\bauth[_-]?header\b/i,
  /\bsynapse[_-]?response\b/i,
  /^0x[a-fA-F0-9]{64}$/,
  /^eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]+\.[A-Za-z0-9_.+/=-]+$/, // JWT-shaped
];

/**
 * Syntactic-only validator for `RAW_STORAGE_FILECOIN_PRIVATE_KEY`.
 * Accepts a 32-byte hex string with `0x` prefix (case-insensitive).
 * Throws on any other shape WITHOUT echoing the value — the message
 * names only the env var and the expected pattern.
 */
export function parseFilecoinPrivateKey(value: string): string {
  if (!PRIVATE_KEY_PATTERN.test(value)) {
    throw new Error(
      "RAW_STORAGE_FILECOIN_PRIVATE_KEY must match '^0x[a-fA-F0-9]{64}$' " +
        "(0x-prefixed 32-byte hex).",
    );
  }
  return value;
}

/**
 * Return the names of every `RAW_STORAGE_FILECOIN_*` key the
 * operator set to a non-empty value. Used by the central
 * cross-provider guard in `src/config.ts` so non-filecoin
 * deployments cannot accidentally carry Filecoin config.
 */
export function collectFilecoinProviderEnvKeys(
  env: Record<string, string | undefined>,
): ReadonlyArray<string> {
  const out: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(FILECOIN_PROVIDER_ENV_PREFIX)) continue;
    const value = env[key];
    if (value !== undefined && value !== '') out.push(key);
  }
  return out;
}

/**
 * Parse + validate the Synapse-shaped Filecoin provider env block.
 * Only invoked when `RAW_STORAGE_PROVIDER=filecoin`; the cross-
 * provider guard runs in `src/config.ts` before this function.
 */
export function parseFilecoinProviderConfig(
  env: Record<string, string | undefined>,
): FilecoinProviderConfig {
  const driver = requireDriver(env['RAW_STORAGE_FILECOIN_DRIVER']);
  const network = requireNetwork(env['RAW_STORAGE_FILECOIN_NETWORK']);
  const privateKey = requirePrivateKey(env['RAW_STORAGE_FILECOIN_PRIVATE_KEY']);
  const source = requireSource(env['RAW_STORAGE_FILECOIN_SOURCE']);
  const withCdn = requireStrictBool(
    env['RAW_STORAGE_FILECOIN_WITH_CDN'],
    'RAW_STORAGE_FILECOIN_WITH_CDN',
  );
  return {
    driver,
    network,
    privateKey,
    source,
    withCdn,
    providerIds: parseProviderIds(env['RAW_STORAGE_FILECOIN_PROVIDER_IDS']),
    copies: parsePositiveIntOrNull(env['RAW_STORAGE_FILECOIN_COPIES'], 'RAW_STORAGE_FILECOIN_COPIES'),
    dataSetMetadata: parseDataSetMetadata(env['RAW_STORAGE_FILECOIN_DATA_SET_METADATA']),
    maxUploadBytes: parsePositiveIntOrNull(
      env['RAW_STORAGE_FILECOIN_MAX_UPLOAD_BYTES'],
      'RAW_STORAGE_FILECOIN_MAX_UPLOAD_BYTES',
    ),
    minUploadBytes: parsePositiveIntOrNull(
      env['RAW_STORAGE_FILECOIN_MIN_UPLOAD_BYTES'],
      'RAW_STORAGE_FILECOIN_MIN_UPLOAD_BYTES',
    ),
    uploadTimeoutMs: parsePositiveIntOrNull(
      env['RAW_STORAGE_FILECOIN_UPLOAD_TIMEOUT_MS'],
      'RAW_STORAGE_FILECOIN_UPLOAD_TIMEOUT_MS',
    ),
    retrievalTimeoutMs: parsePositiveIntOrNull(
      env['RAW_STORAGE_FILECOIN_RETRIEVAL_TIMEOUT_MS'],
      'RAW_STORAGE_FILECOIN_RETRIEVAL_TIMEOUT_MS',
    ),
  };
}

function requireDriver(value: string | undefined): FilecoinDriver {
  if (value === 'synapse' || value === 'filecoin_pin') return value;
  throw new Error(
    `RAW_STORAGE_FILECOIN_DRIVER must equal 'synapse' or 'filecoin_pin' ` +
      `(got '${value ?? '<unset>'}'). Phase 5 evaluation: 'synapse' is the ` +
      "default direct driver; 'filecoin_pin' is the opt-in CAR-first driver " +
      'backed by the `filecoin-pin` package. The driver choice is purely an ' +
      'internal selector — neither value is exposed on any public surface.',
  );
}

function requireNetwork(value: string | undefined): FilecoinNetwork {
  if (value === 'calibration' || value === 'mainnet') return value;
  throw new Error(
    `RAW_STORAGE_FILECOIN_NETWORK must be 'calibration' or 'mainnet' ` +
      `(got '${value ?? '<unset>'}').`,
  );
}

function requirePrivateKey(value: string | undefined): string {
  if (!value) {
    throw new Error('RAW_STORAGE_FILECOIN_PRIVATE_KEY is required.');
  }
  return parseFilecoinPrivateKey(value);
}

function requireSource(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new Error('RAW_STORAGE_FILECOIN_SOURCE is required (non-empty).');
  }
  return trimmed;
}

function requireStrictBool(value: string | undefined, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be 'true' or 'false' (got '${value ?? '<unset>'}').`);
}

/**
 * Synapse SDK provider IDs are on-chain uint256 values; the wire
 * encoding is a positive decimal bigint string. We validate the
 * shape at startup (no leading zeros, no hex, no float, no zero,
 * no negative) so the Synapse `BigInt(id)` cast inside
 * `synapse-client.ts` can never throw a raw `SyntaxError` that
 * escapes the provider boundary.
 */
const POSITIVE_DECIMAL_BIGINT = /^[1-9][0-9]*$/;

function parseProviderIds(value: string | undefined): ReadonlyArray<string> {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!POSITIVE_DECIMAL_BIGINT.test(trimmed)) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_PROVIDER_IDS entry '${trimmed}' is not a positive ` +
          'decimal bigint (Synapse provider IDs are on-chain uint256 values).',
      );
    }
    if (seen.has(trimmed)) {
      throw new Error(`RAW_STORAGE_FILECOIN_PROVIDER_IDS contains duplicate entry '${trimmed}'.`);
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parsePositiveIntOrNull(value: string | undefined, name: string): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be a positive integer (got '${value}').`);
  }
  return parsed;
}

function parseDataSetMetadata(
  raw: string | undefined,
): Readonly<Record<string, string | number | boolean>> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('RAW_STORAGE_FILECOIN_DATA_SET_METADATA must be valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RAW_STORAGE_FILECOIN_DATA_SET_METADATA must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new Error(
      `RAW_STORAGE_FILECOIN_DATA_SET_METADATA exceeds ${MAX_METADATA_KEYS} keys.`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    rejectMetadataKey(key);
    out[key] = coerceMetadataValue(key, obj[key]);
  }
  return out;
}

function rejectMetadataKey(key: string): void {
  rejectMetadataKeyShape(key);
  rejectMetadataKeyReservedPrefix(key);
  rejectMetadataKeyCredentialShape(key);
}

function rejectMetadataKeyShape(key: string): void {
  if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) {
    throw new Error(
      `RAW_STORAGE_FILECOIN_DATA_SET_METADATA key length must be 1..${MAX_METADATA_KEY_LENGTH}.`,
    );
  }
  if (!METADATA_KEY_PATTERN.test(key)) {
    throw new Error(
      `RAW_STORAGE_FILECOIN_DATA_SET_METADATA key '${key}' contains disallowed characters. ` +
        "Keys must match '[A-Za-z0-9_.:-]+'.",
    );
  }
}

function rejectMetadataKeyReservedPrefix(key: string): void {
  for (const prefix of FILECOIN_METADATA_RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_DATA_SET_METADATA key '${key}' uses reserved prefix '${prefix}'.`,
      );
    }
  }
}

function rejectMetadataKeyCredentialShape(key: string): void {
  const lower = key.toLowerCase();
  for (const denied of FILECOIN_METADATA_DENYLIST) {
    if (lower === denied || lower.includes(denied)) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_DATA_SET_METADATA key '${key}' matches a denylisted credential shape.`,
      );
    }
  }
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    if (pattern.test(key)) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_DATA_SET_METADATA key '${key}' matches a denylisted credential shape.`,
      );
    }
  }
}

function coerceMetadataValue(key: string, value: unknown): string | number | boolean {
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_DATA_SET_METADATA value for '${key}' exceeds ` +
          `${MAX_METADATA_VALUE_LENGTH} characters (got ${value.length}).`,
      );
    }
    rejectCredentialShapedValue(key, value);
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  throw new Error(
    `RAW_STORAGE_FILECOIN_DATA_SET_METADATA value for '${key}' must be a scalar ` +
      '(string, finite number, or boolean).',
  );
}

function rejectCredentialShapedValue(key: string, value: string): void {
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `RAW_STORAGE_FILECOIN_DATA_SET_METADATA value for '${key}' matches a denylisted credential shape.`,
      );
    }
  }
}
