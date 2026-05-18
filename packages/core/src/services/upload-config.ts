/**
 * @file Typed configuration for the managed-blob upload pipeline.
 *
 * Discriminated by `rawStorageMode` so pointer-only deployments
 * carry no HMAC secret at all (vs. holding a placeholder that is
 * "never consumed in practice" — that earlier shape violated the
 * workspace no-fallback rule and made it possible to leak a fake
 * value into service code).
 *
 *   - `pointer_only` deployments: `{rawStorageMode, rawStoragePrefix}`
 *     only. No key derivation runs in this branch, so the HMAC
 *     secret is structurally absent.
 *   - `managed_blob` deployments: REQUIRED `storageKeyHmacSecret`.
 *     `runtime-container` narrows `RuntimeConfig` to this variant
 *     when it constructs the document upload pipeline; tests build
 *     the variant directly with `TEST_STORAGE_KEY_HMAC_SECRET`.
 *
 * Callers narrow with `rawStorageMode === 'managed_blob'` (the
 * upload pipeline's early-return gate is exactly that check), at
 * which point the secret is statically available without any
 * runtime defensive read.
 */

/** Pointer-only — no managed-key derivation runs in this branch. */
export interface UploadConfigPointerOnly {
  rawStorageMode: 'pointer_only';
  rawStoragePrefix: string;
}

/** Managed-blob — HMAC secret required to derive PII-safe key prefixes. */
export interface UploadConfigManagedBlob {
  rawStorageMode: 'managed_blob';
  rawStoragePrefix: string;
  storageKeyHmacSecret: string;
}

export type UploadConfig = UploadConfigPointerOnly | UploadConfigManagedBlob;
