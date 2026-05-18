/**
 * @file Compute the direct storage API's capability snapshot.
 *
 * Maps an active `RawContentStore` (or its absence) to the public
 * `StorageCapabilitiesResponse` the `/v1/storage/capabilities` route
 * emits. Pure projection; no IO. Routes hand the result straight to
 * the schema validator.
 *
 * Provider-specific honesty: the response
 * describes what the **direct** storage API (`/v1/storage/artifacts/*`)
 * supports. Filecoin direct managed upload is a 501 in v1, so every
 * "supports*" claim for Filecoin reports `false` here. The fuller
 * Filecoin feature set (`supportsContentHash`, `supportsContentAddressedUri`,
 * provider proofs, etc.) is reachable only through document ingestion
 * and is reported by `/v1/documents/limits` instead — that surface is
 * untouched.
 *
 * Pointer-only deployments (no `RawContentStore`) report `provider:'none'`
 * with every "supports*" flag false. Pointer-mode put against such a
 * deployment still works in the storage-route implementation (pointer mode is independent of the
 * managed backend), but the capabilities response correctly says there
 * is no direct managed upload available.
 */

import type { RawContentStore } from './raw-content-store.js';
import type { StorageCapabilitiesResponse } from '../schemas/storage-schemas.js';

export interface StorageCapabilitiesSnapshot {
  /**
   * Active raw-content store, or `null` for `pointer_only` deployments.
   * The route layer reads `runtime.rawContentStore` and forwards it
   * here unchanged.
   */
  activeStore: RawContentStore | null;
  /**
   * `rawUploadMaxBytes` from runtime config. v1 keeps the existing
   * 25 MiB cap from document ingestion (Streaming + Resumable Uploads
   * PR will lift this).
   */
  rawUploadMaxBytes: number;
}

const POINTER_ONLY_PROVIDER = 'none';

/**
 * Closed allowlist of providers the direct storage API explicitly
 * knows about. Any provider not in this set falls through to
 * `unknownProviderCapabilities`, which reports every `supports*`
 * flag as false so a future provider or test adapter does not
 * accidentally inherit the location-addressed
 * direct-upload shape.
 */
const KNOWN_LOCATION_ADDRESSED_PROVIDERS = new Set(['local_fs', 's3']);
const KNOWN_EVENTUAL_DIRECT_UNSUPPORTED_PROVIDERS = new Set(['filecoin']);

/**
 * Build the capability response for the direct storage API.
 *
 * Treats the Filecoin direct-upload carve-out as authoritative:
 * regardless of what the underlying `FilecoinRawContentStore`
 * advertises, the direct API surface reports every capability as
 * false for Filecoin in v1. Lifting that carve-out is the job of a
 * follow-up PR (storage-artifact reconciler + Filecoin direct
 * support).
 *
 * Unknown providers fail closed: the response carries the provider
 * name (so operators can see what is configured) but advertises no
 * direct upload, no content-hash disclosure, no delete, no addressing,
 * etc. A new backend must be explicitly added to this switch before
 * any direct-API claim is true for it.
 */
export function getStorageCapabilities(
  snapshot: StorageCapabilitiesSnapshot,
): StorageCapabilitiesResponse {
  const store = snapshot.activeStore;
  if (store === null) return pointerOnlyCapabilities();
  if (KNOWN_LOCATION_ADDRESSED_PROVIDERS.has(store.provider)) {
    return locationAddressedCapabilities(store.provider, snapshot.rawUploadMaxBytes);
  }
  if (KNOWN_EVENTUAL_DIRECT_UNSUPPORTED_PROVIDERS.has(store.provider)) {
    return eventualDirectUnsupportedCapabilities(store.provider);
  }
  return unknownProviderCapabilities(store.provider);
}

function pointerOnlyCapabilities(): StorageCapabilitiesResponse {
  return {
    provider: POINTER_ONLY_PROVIDER,
    addressing: [],
    consistency: 'immediate',
    supportsDirectUpload: false,
    supportsRangeRead: false,
    supportsDelete: false,
    supportsTombstone: false,
    supportsBundles: false,
    supportedBundleFormats: [],
    supportsVerification: false,
    supportsProviderProofs: false,
    supportsReplication: false,
    supportsRetrievalStatus: false,
    supportsContentHash: false,
    supportsContentAddressedUri: false,
    deleteSemantics: [],
    availabilityModel: 'immediate',
  };
}

/**
 * Filecoin-shaped eventual providers in v1: direct managed upload is
 * 501. The plan pins three fields to false (`supportsDirectUpload`,
 * `supportsContentHash`, `supportsContentAddressedUri`); everything
 * else also reports false because no direct-API operation can target
 * these managed artifacts yet.
 *
 * `consistency` and `availabilityModel` remain Filecoin-shaped
 * (`eventual` / `delayed`) so a future release that lifts the carve-out
 * doesn't have to change those — they describe the backend, not the
 * v1 carve-out.
 */
function eventualDirectUnsupportedCapabilities(provider: string): StorageCapabilitiesResponse {
  return {
    provider,
    addressing: [],
    consistency: 'eventual',
    supportsDirectUpload: false,
    supportsRangeRead: false,
    supportsDelete: false,
    supportsTombstone: false,
    supportsBundles: false,
    supportedBundleFormats: [],
    supportsVerification: false,
    supportsProviderProofs: false,
    supportsReplication: false,
    supportsRetrievalStatus: false,
    supportsContentHash: false,
    supportsContentAddressedUri: false,
    deleteSemantics: [],
    availabilityModel: 'delayed',
  };
}

function locationAddressedCapabilities(
  provider: string,
  maxUploadBytes: number,
): StorageCapabilitiesResponse {
  return {
    provider,
    addressing: ['location'],
    consistency: 'immediate',
    maxUploadBytes,
    supportsDirectUpload: true,
    supportsRangeRead: false,
    supportsDelete: true,
    supportsTombstone: false,
    supportsBundles: false,
    supportedBundleFormats: [],
    // the storage-route implementation ships the verify route + a backend.head()-based shim;
    // location-addressed providers report `true`. Pointer-mode
    // artifacts of any provider still report `kind: 'unsupported'`
    // at runtime (the server never touches the pointer URI).
    supportsVerification: true,
    supportsProviderProofs: false,
    supportsReplication: false,
    supportsRetrievalStatus: false,
    supportsContentHash: true,
    supportsContentAddressedUri: false,
    deleteSemantics: ['delete'],
    availabilityModel: 'immediate',
  };
}

/**
 * Fail-closed shape for any provider the direct storage API does not
 * yet explicitly support. Carries the provider name so operators can
 * see what is configured, but advertises no managed-upload capability.
 * A new backend must be wired into `getStorageCapabilities` (and the
 * Step-5 storage service) before any flag becomes true for it.
 */
function unknownProviderCapabilities(provider: string): StorageCapabilitiesResponse {
  return {
    provider,
    addressing: [],
    consistency: 'immediate',
    supportsDirectUpload: false,
    supportsRangeRead: false,
    supportsDelete: false,
    supportsTombstone: false,
    supportsBundles: false,
    supportedBundleFormats: [],
    supportsVerification: false,
    supportsProviderProofs: false,
    supportsReplication: false,
    supportsRetrievalStatus: false,
    supportsContentHash: false,
    supportsContentAddressedUri: false,
    deleteSemantics: [],
    availabilityModel: 'immediate',
  };
}
