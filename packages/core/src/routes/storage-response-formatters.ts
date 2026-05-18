/**
 * @file Wire-shape projections for the direct storage API.
 *
 * Every public response for the
 * `/v1/storage/artifacts*` routes flows through `formatStoredArtifact`
 * which:
 *
 *   1. Builds the wire object by EXPLICIT named-key construction.
 *      Internal columns (`stored_hash`, `last_error`, `delete_attempt_id`)
 *      are never read. The plaintext `content_hash` is included only
 *      when the row's `disclose_content_hash` was true at put time.
 *   2. Runs the result through provider-specific redaction
 *      (`redactArtifactPublic`) so `identifiers` / `provider_details`
 *      land in a closed allowlist for each known provider.
 *   3. Validates the projection with `StoredArtifactResponseSchema.strict()`
 *      — the formatter is the primary projector; the schema is the
 *      defence-in-depth lock that drops any field that slipped past
 *      the named-key construction.
 *
 * Callers throw if the schema parse fails; that signals a regression
 * in the projection logic itself (the schema is impossible to
 * violate by data alone since the formatter constructs the object
 * key-by-key).
 */

import type { StorageArtifactRow } from '../db/storage-artifact-repository.js';
import { redactArtifactPublic } from '../storage/artifact-public-redaction.js';
import {
  StoredArtifactResponseSchema,
  type StoredArtifactResponse,
} from '../schemas/storage-schemas.js';

/** Closed allowlists of nested keys we may publish per state envelope. */
const REPLICATION_KEYS = ['desiredCopies', 'confirmedCopies'] as const;
const VERIFICATION_KEYS = ['providerProofStatus', 'lastVerifiedAt'] as const;
const RETRIEVAL_KEYS = ['status', 'lastCheckedAt'] as const;

/**
 * Project a repository row into its wire shape.
 *
 * @throws ZodError if the strict schema rejects the projected object —
 *   that means the formatter dropped an internal field on the wire.
 *   Tests must catch any regression here.
 */
export function formatStoredArtifact(row: StorageArtifactRow): StoredArtifactResponse {
  const redacted = redactArtifactPublic(row.provider, {
    identifiers: row.identifiers,
    providerDetails: row.providerDetails,
  });
  const wire: Record<string, unknown> = {
    artifact_id: row.id,
    provider: row.provider,
    mode: row.mode,
    uri: row.uri,
    status: row.status,
    size_bytes: row.sizeBytes,
    content_type: row.contentType,
    content_encoding: row.contentEncoding,
    identifiers: redacted.identifiers,
    lifecycle: deriveLifecycle(row),
    metadata: projectPublicMetadata(row.metadata),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
  if (row.discloseContentHash && row.plaintextHash !== null) {
    wire.content_hash = row.plaintextHash;
  }
  if (Object.keys(redacted.providerDetails).length > 0) {
    wire.provider_details = redacted.providerDetails;
  }
  const replication = projectStateEnvelope(row.replication, REPLICATION_KEYS);
  if (replication !== null) wire.replication = replication;
  const verification = projectStateEnvelope(row.verification, VERIFICATION_KEYS);
  if (verification !== null) wire.verification = verification;
  const retrieval = projectStateEnvelope(row.retrieval, RETRIEVAL_KEYS);
  if (retrieval !== null) wire.retrieval = retrieval;
  return StoredArtifactResponseSchema.parse(wire);
}

/**
 * Lifecycle is a derived projection from `(provider, mode)`: pointer
 * artifacts have no async lifecycle (`availability: 'immediate'`,
 * no delete semantics); managed artifacts get the location-addressed
 * shape on `local_fs`/`s3` and delayed/tombstone semantics on
 * content-addressed eventual providers (`filecoin`). Any
 * other backend reports an empty envelope (fail-closed). The row's
 * `lifecycle` JSONB column is reserved for future per-row overrides;
 * the derived projection currently wins.
 */
function deriveLifecycle(
  row: StorageArtifactRow,
): { availability?: string; deleteSemantics?: string } {
  if (row.mode === 'pointer') return { availability: 'immediate' };
  if (row.provider === 'local_fs' || row.provider === 's3') {
    return { availability: 'immediate', deleteSemantics: 'delete' };
  }
  if (row.provider === 'filecoin') {
    return { availability: 'delayed', deleteSemantics: 'tombstone' };
  }
  return {};
}

/**
 * Defensive projection for the public `metadata` field.
 *
 * Write paths validate metadata with `validateArtifactMetadata`
 * (closed leaf-type set: string | number | boolean; ≤4 KiB), but a
 * row that was inserted before that check existed — or via a
 * direct SQL ops fix — could carry arrays, nested objects, or
 * other non-leaf values. The previous formatter blindly cast the
 * raw JSONB through `as Record<string, string | number | boolean>`,
 * which silently leaked the unsanitized shape onto the wire.
 *
 * This projection iterates the row's own keys and emits ONLY the
 * leaf-type entries; everything else (arrays, nested objects,
 * null, undefined, functions) is dropped. Non-object inputs
 * project to `{}`. The closed allowlist matches the write-side
 * `ArtifactMetadata` contract.
 */
function projectPublicMetadata(value: unknown): Record<string, string | number | boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Project a state envelope (replication / verification / retrieval)
 * via the same project-then-validate discipline as the top-level
 * artifact: build an allowlisted object by named keys, drop unknown
 * keys, and only emit the envelope when at least one allowlisted
 * key is populated.
 */
function projectStateEnvelope(
  raw: Record<string, unknown> | null,
  keys: ReadonlyArray<string>,
): Record<string, unknown> | null {
  if (raw === null) return null;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Wire headers for `HEAD /v1/storage/artifacts/:id`. */
export interface ArtifactHeadHeaders {
  contentType: string;
  contentLength: number;
  artifactId: string;
  storageMode: 'pointer' | 'managed';
  storageStatus: string;
  provider: string;
}

export function formatArtifactHeadHeaders(row: StorageArtifactRow): ArtifactHeadHeaders {
  return {
    contentType: row.contentType ?? 'application/octet-stream',
    // Pointer artifacts report 0 — the server has no bytes to count.
    contentLength: row.mode === 'managed' ? (row.sizeBytes ?? 0) : 0,
    artifactId: row.id,
    storageMode: row.mode,
    storageStatus: row.status,
    provider: row.provider,
  };
}
