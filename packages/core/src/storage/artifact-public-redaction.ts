/**
 * @file Per-provider redaction for `storage_artifacts` wire responses.
 *
 * Explicit projection from the
 * (potentially noisy) `provider_metadata` / `identifiers` columns to
 * the closed set of fields each provider is allowed to surface on
 * the wire. Project-then-validate: the formatter constructs the
 * allowlisted object by named keys, and the `StoredArtifactResponseSchema`
 * `.strict()` parse in the route layer is the final lock that drops
 * any field the formatter accidentally let through.
 *
 * Scope: backends that v1 actually writes (`local_fs`, `s3`,
 * `filecoin`). Filecoin direct managed uploads are 501 in v1 so the
 * filecoin formatter mostly matters for pointer-mode artifacts that
 * carry caller-supplied `identifiers` (e.g. an IPFS CID the caller
 * already knows).
 */

/** Wire shape — discoverable identifiers only. Values are scalars. */
export type PublicArtifactIdentifiers = Record<string, string>;

/** Wire shape — provider-side public state. */
export type PublicArtifactProviderDetails = Record<string, unknown>;

/** Closed allowlists, one per known provider. */
const LOCAL_FS_IDENTIFIER_KEYS = ['etag'] as const;
const LOCAL_FS_PROVIDER_DETAIL_KEYS: ReadonlyArray<string> = [];

const S3_IDENTIFIER_KEYS = ['etag', 'versionId'] as const;
const S3_PROVIDER_DETAIL_KEYS = ['bucket', 'region'] as const;

const FILECOIN_IDENTIFIER_KEYS = ['ipfsCid', 'pieceCid', 'carRootCid', 'dataSetId'] as const;
/**
 * Filecoin currently has NO public `provider_details`. Keeping this
 * empty prevents the wire from carrying provider fields the storage
 * backend has not explicitly projected.
 */
const FILECOIN_PROVIDER_DETAIL_KEYS: ReadonlyArray<string> = [];

/**
 * Project a raw `(identifiers, providerDetails)` pair into the
 * provider-specific public shape. Unknown providers contribute an
 * empty object on both fields — the formatter never falls back to a
 * passthrough.
 */
export function redactArtifactPublic(provider: string, raw: {
  identifiers: Record<string, unknown>;
  providerDetails: Record<string, unknown> | null;
}): { identifiers: PublicArtifactIdentifiers; providerDetails: PublicArtifactProviderDetails } {
  const idKeys = identifierKeysFor(provider);
  const detailKeys = providerDetailKeysFor(provider);
  return {
    identifiers: pickStringKeys(raw.identifiers, idKeys),
    providerDetails: pickScalarKeys(raw.providerDetails ?? {}, detailKeys),
  };
}

function identifierKeysFor(provider: string): ReadonlyArray<string> {
  if (provider === 'local_fs') return LOCAL_FS_IDENTIFIER_KEYS;
  if (provider === 's3') return S3_IDENTIFIER_KEYS;
  if (provider === 'filecoin') return FILECOIN_IDENTIFIER_KEYS;
  return [];
}

function providerDetailKeysFor(provider: string): ReadonlyArray<string> {
  if (provider === 'local_fs') return LOCAL_FS_PROVIDER_DETAIL_KEYS;
  if (provider === 's3') return S3_PROVIDER_DETAIL_KEYS;
  if (provider === 'filecoin') return FILECOIN_PROVIDER_DETAIL_KEYS;
  return [];
}

function pickStringKeys(
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): PublicArtifactIdentifiers {
  const out: PublicArtifactIdentifiers = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

function pickScalarKeys(
  source: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): PublicArtifactProviderDetails {
  const out: PublicArtifactProviderDetails = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}
