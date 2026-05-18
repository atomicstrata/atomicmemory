/**
 * @file Zod schemas for the direct storage API (`/v1/storage/*`).
 *
 * Mirrors the Step-2 SDK type surface (`atomicmemory-sdk/src/storage`)
 * closely enough for two purposes:
 *
 *   1. **Capability response validation** — `GET /v1/storage/capabilities`
 *      runs its emitted body through `StorageCapabilitiesResponseSchema`
 *      so the response formatter cannot leak internal fields.
 *   2. **Future request validation** — pointer-mode put bodies, managed
 *      mode put query params, and delete-policy query params have
 *      strict schemas defined here even though their routes don't ship
 *      until the storage-route implementation. Locking the shape now means the storage-route implementation can wire the
 *      schemas straight into `validateBody` / `validateQuery` without
 *      relitigating the contract.
 *
 * Every object schema is `.strict()` so unknown keys are rejected as
 * an additional defence in depth against accidental field leaks. The
 * route formatter is the primary projector; `.strict()` is the lock.
 *
 * Wire shape matches the SDK's `StorageCapabilities` type field names
 * (camelCase). The plan's rev-6 smoke test pins this:
 *
 *   `curl GET /v1/storage/capabilities` →
 *     `{ provider: "local_fs", supportsDirectUpload: true, ... }`
 */

import { z } from './zod-setup.js';

// ---------------------------------------------------------------------------
// Closed enums — internal building blocks for the public schemas below.
// File-private; mirror the SDK type unions one-to-one.
// ---------------------------------------------------------------------------

const StorageAddressingModeSchema = z
  .enum(['location', 'content', 'provider_native'])
  .openapi({ description: 'How the backend addresses stored bytes.' });

const StorageConsistencySchema = z
  .enum(['immediate', 'eventual'])
  .openapi({ description: 'When bytes become retrievable after put.' });

const StorageAvailabilityModelSchema = z
  .enum(['immediate', 'delayed', 'scheduled', 'best_effort'])
  .openapi({ description: 'Coarse availability category for the backend.' });

const StorageDeleteSemanticsSchema = z
  .enum(['delete', 'unpin', 'tombstone', 'provider_retained'])
  .openapi({
    description:
      'What the backend does on delete. `delete` issues provider ' +
      'removal; `unpin` removes the AtomicMemory reference only; ' +
      "`tombstone` stops managing without provider removal (typical " +
      'for decentralized providers); `provider_retained` is reserved.',
  });

// ---------------------------------------------------------------------------
// Capabilities response — the wire shape `GET /v1/storage/capabilities`
// emits. Mirrors `StorageCapabilities` from the SDK.
// ---------------------------------------------------------------------------

export const StorageCapabilitiesResponseSchema = z
  .object({
    provider: z.string(),
    addressing: z.array(StorageAddressingModeSchema),
    consistency: StorageConsistencySchema,
    maxUploadBytes: z.number().int().positive().optional(),
    minUploadBytes: z.number().int().nonnegative().optional(),
    supportsDirectUpload: z.boolean(),
    supportsRangeRead: z.boolean(),
    supportsDelete: z.boolean(),
    supportsTombstone: z.boolean(),
    supportsBundles: z.boolean(),
    supportedBundleFormats: z.array(z.string()),
    supportsVerification: z.boolean(),
    supportsProviderProofs: z.boolean(),
    supportsReplication: z.boolean(),
    supportsRetrievalStatus: z.boolean(),
    supportsContentHash: z.boolean(),
    supportsContentAddressedUri: z.boolean(),
    deleteSemantics: z.array(StorageDeleteSemanticsSchema),
    availabilityModel: StorageAvailabilityModelSchema,
  })
  .strict()
  .openapi({
    description:
      'Capability snapshot for the direct storage API ' +
      '(`/v1/storage/artifacts/*`). Composition-time projection; no ' +
      "per-user state. Document ingestion's own capability surface " +
      'lives at `/v1/documents/limits` and may report different ' +
      'flags (e.g. Filecoin reports `supportsContentHash: true` ' +
      'through documents but `false` here in v1 because direct ' +
      'managed Filecoin upload is not yet supported).',
  });

export type StorageCapabilitiesResponse = z.infer<
  typeof StorageCapabilitiesResponseSchema
>;

// ---------------------------------------------------------------------------
// Caller-supplied artifact metadata. Shape matches the SDK's
// `Record<string, string | number | boolean>` and is reused by the
// pointer-mode JSON body + the managed-mode `X-AtomicMemory-Metadata`
// header (wired in the storage-route implementation).
// ---------------------------------------------------------------------------

const ArtifactMetadataSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .openapi({
    description:
      'Caller-supplied metadata. Decoded JSON must be ≤4 KiB; encoded ' +
      'header value must be ≤8 KiB when sent via ' +
      '`X-AtomicMemory-Metadata`.',
  });

// ---------------------------------------------------------------------------
// Put-artifact request shapes. Pointer mode lives in the JSON body;
// managed mode is `?mode=managed&...` with raw bytes in the body (no
// JSON envelope). Both schemas are wired now so the storage-route implementation's routes can
// validate without re-deriving the contract.
// ---------------------------------------------------------------------------

export const PutPointerBodySchema = z
  .object({
    mode: z.literal('pointer'),
    uri: z.string().min(1),
    content_type: z.string().min(1),
    size_bytes: z.number().int().nonnegative().optional(),
    content_hash: z.string().min(1).optional(),
    metadata: ArtifactMetadataSchema.optional(),
  })
  .strict()
  .openapi({
    description:
      'Pointer-mode artifact registration body. The server stores ' +
      'the URI as a reference; it NEVER fetches the URI itself.',
  });

export type PutPointerBody = z.infer<typeof PutPointerBodySchema>;

const PutManagedBodySchema = z
  .object({
    mode: z.literal('managed'),
  })
  .strict()
  .openapi({
    description:
      'Managed-mode marker. The route uses query params for the ' +
      'managed-mode contract; the body is raw bytes, not JSON. ' +
      'Included in the discriminated union so a managed-mode JSON ' +
      'body (caller mistake) parses cleanly and is rejected at the ' +
      'route layer.',
  });

export const PutArtifactBodySchema = z
  .discriminatedUnion('mode', [PutPointerBodySchema, PutManagedBodySchema])
  .openapi({ description: 'Discriminated union over put-artifact mode.' });

// Note: the managed-mode put route parses query params manually
// (Content-Length, force-rejection, and the disclose flag have
// distinct error envelopes that don't compose cleanly with
// `validateQuery`). The schema lives here as authoritative
// documentation of the contract; OpenAPI references it indirectly
// via the discriminated `PutArtifactBodySchema`.

// ---------------------------------------------------------------------------
// Delete-artifact closed-policy enum. No `force`; orphan recovery is
// intentionally restricted to operator workflows.
// ---------------------------------------------------------------------------

export const DeleteArtifactPolicySchema = z
  .enum(['artifact_only', 'with_documents'])
  .openapi({
    description:
      'Delete behaviour when documents reference the artifact. ' +
      '`artifact_only` (default) returns 409 `artifact_in_use` if ' +
      'any non-deleted documents reference it. `with_documents` ' +
      'cascades a soft-delete to those documents first.',
  });

// The delete route parses query params manually so it can reject
// `force` explicitly (the plan disallows the verb in the public API).
// OpenAPI references `DeleteArtifactPolicySchema` directly in the
// route registration; no separate query-object export is needed.

// ---------------------------------------------------------------------------
// Stored artifact response shape — wire projection emitted by every
// public route that returns artifact metadata (PUT pointer/managed,
// GET, verify, delete).
//
// Mirrors the SDK's `StoredArtifact`. Field naming is snake_case to
// match the existing core wire convention. The route formatter is
// responsible for explicit projection; this schema is the final
// `.strict()` lock.
// ---------------------------------------------------------------------------

const ArtifactIdentifiersSchema = z
  .record(z.string(), z.string())
  .openapi({ description: 'Provider-native identifiers (CID, etc.); allowlisted per provider.' });

const ProviderDetailsSchema = z
  .record(z.string(), z.unknown())
  .openapi({ description: 'Allowlisted provider-specific public state.' });

const LifecycleSchema = z
  .object({
    availability: StorageAvailabilityModelSchema.optional(),
    deleteSemantics: StorageDeleteSemanticsSchema.optional(),
  })
  .strict()
  .openapi({
    description:
      'Provider-agnostic summary of availability + delete-semantics. ' +
      'Both fields are optional so a row whose lifecycle is not yet ' +
      'known to the API surface validates cleanly.',
  });

const ReplicationStateSchema = z
  .object({
    desiredCopies: z.number().int().nonnegative().optional(),
    confirmedCopies: z.number().int().nonnegative().optional(),
  })
  .strict()
  .openapi({ description: 'Optional replication state for eventual storage providers.' });

const VerificationStateSchema = z
  .object({
    providerProofStatus: z
      .enum(['pending', 'verified', 'failed', 'unsupported'])
      .optional(),
    lastVerifiedAt: z.string().optional(),
  })
  .strict()
  .openapi({ description: 'Optional verification state (provider proofs).' });

const RetrievalStateSchema = z
  .object({
    status: z
      .enum(['not_checked', 'retrievable', 'not_retrievable', 'unsupported'])
      .optional(),
    lastCheckedAt: z.string().optional(),
  })
  .strict()
  .openapi({ description: 'Optional retrieval-readiness state.' });

export const StoredArtifactResponseSchema = z
  .object({
    artifact_id: z.string().uuid(),
    provider: z.string(),
    mode: z.enum(['pointer', 'managed']),
    // Nullable for managed pending/failed rows whose backend put
    // never returned a URI. Pointer rows always carry the
    // caller-supplied URI; managed `stored` / `available` rows
    // carry the adapter URI. `pending` / `failed` rows surface
    // `uri: null` honestly.
    uri: z.string().nullable(),
    status: z.enum([
      'stored',
      'pending',
      'available',
      'unavailable',
      'deleting',
      'deleted',
      'delete_failed',
      'failed',
    ]),
    size_bytes: z.number().int().nonnegative().nullable(),
    content_type: z.string().nullable(),
    /** Plaintext SHA-256 of caller bytes — present only when the put
     * was made with `disclose_content_hash=true`. Stored internally
     * for diagnostic queries either way. */
    content_hash: z.string().optional(),
    content_encoding: z.enum(['identity', 'aes_gcm']),
    identifiers: ArtifactIdentifiersSchema,
    /** Always present; populated from `(provider, mode)` derivation. */
    lifecycle: LifecycleSchema,
    /** Optional state envelopes — only surfaced when the row column
     * carries data. the storage-route implementation ships them as wire-shape stubs; the paired artifact-sync implementation's
     * sync hook populates them for Filecoin-backed rows. */
    replication: ReplicationStateSchema.optional(),
    verification: VerificationStateSchema.optional(),
    retrieval: RetrievalStateSchema.optional(),
    metadata: ArtifactMetadataSchema,
    provider_details: ProviderDetailsSchema.optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .strict()
  .openapi({
    description:
      'Public metadata projection of a `storage_artifacts` row. ' +
      '`content_hash` is the plaintext SHA-256 of caller bytes; the ' +
      'internal `stored_hash` column is NEVER surfaced on the wire.',
  });

export type StoredArtifactResponse = z.infer<typeof StoredArtifactResponseSchema>;

export const VerifyArtifactResultSchema = z
  .object({
    artifact_id: z.string().uuid(),
    kind: z.enum(['verified', 'failed', 'unsupported']),
    reason: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .openapi({
    description:
      'Result of `POST /v1/storage/artifacts/:id/verify`. Pointer-mode ' +
      "artifacts always report `kind: 'unsupported'` because the server " +
      'never fetches the registered URI.',
  });

export const DeleteArtifactResultSchema = z
  .object({
    artifact_id: z.string().uuid(),
    status: z.enum(['deleted', 'delete_failed']),
    cascaded_document_ids: z.array(z.string().uuid()).optional(),
  })
  .strict()
  .openapi({
    description: 'Result of `DELETE /v1/storage/artifacts/:id`.',
  });
