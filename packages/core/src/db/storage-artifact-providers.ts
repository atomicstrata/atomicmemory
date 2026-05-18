/**
 * @file Neutral constants for `storage_artifacts.provider` values.
 *
 * Step 7 originally exported `EXTERNAL_POINTER_PROVIDER` from
 * `services/document-upload-artifact-sync.ts`, but that reversed the
 * dependency direction: `db/raw-document-repository.ts` (a low-level
 * persistence module) had to import from a service. Moving the
 * constant here keeps the DB and service layers free to share it
 * without the cycle.
 */

/**
 * `provider` value for pointer-mode `storage_artifacts` rows created
 * at document-registration time. The bytes live at a caller-supplied
 * URI managed by some external system; the AtomicMemory deployment
 * is NOT the provider — it only tracks the reference. Treated as a
 * backend-agnostic external pointer; the redaction allowlist
 * (`src/storage/artifact-public-redaction.ts`) does not have an
 * entry for `'external_pointer'`, so `identifiers` /
 * `provider_details` come back as empty objects on the wire.
 */
export const EXTERNAL_POINTER_PROVIDER = 'external_pointer' as const;
