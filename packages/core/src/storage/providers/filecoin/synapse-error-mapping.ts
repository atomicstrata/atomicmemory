/**
 * @file Vendor → boundary error mapping for `SynapseFilecoinProviderClient`.
 *
 * Each helper replaces a raw `@filoz/synapse-sdk` error with a
 * sanitized `FilecoinProviderError` carrying a closed-set
 * `errorCode`. The vendor `message` string NEVER reaches the
 * boundary — it could embed wallet addresses, balances, signed
 * requests, RPC URLs, or other operator-internal data that the
 * provider package promises not to leak. The replacement message
 * is a fixed, hand-written sentence whose ONLY variability is the
 * stable `errorCode`.
 *
 * Lives in its own module so `synapse-client.ts` stays under the
 * workspace 400-LOC cap. The boundary surface here is consumed
 * only by `synapse-client.ts`; nothing else in the provider
 * package depends on these helpers.
 */

import { FilecoinProviderError } from './errors.js';

export function wrapSynapseUploadError(
  err: unknown,
  signal: AbortSignal | undefined,
): FilecoinProviderError {
  if (signal?.aborted) {
    return new FilecoinProviderError(
      'filecoin_upload_timeout',
      'Synapse upload aborted by RAW_STORAGE_FILECOIN_UPLOAD_TIMEOUT_MS.',
    );
  }
  if (err instanceof FilecoinProviderError) return err;
  return new FilecoinProviderError(
    'filecoin_upload_failed',
    'Synapse upload failed; vendor error suppressed at the provider boundary.',
  );
}

export function wrapSynapseDownloadError(
  err: unknown,
  signal: AbortSignal | undefined,
): FilecoinProviderError {
  if (signal?.aborted) {
    return new FilecoinProviderError(
      'filecoin_download_timeout',
      'Synapse download aborted by RAW_STORAGE_FILECOIN_RETRIEVAL_TIMEOUT_MS.',
    );
  }
  if (err instanceof FilecoinProviderError) return err;
  return new FilecoinProviderError(
    'filecoin_download_failed',
    'Synapse download failed; vendor error suppressed at the provider boundary.',
  );
}

export function wrapSynapseHeadError(err: unknown): FilecoinProviderError {
  if (err instanceof FilecoinProviderError) return err;
  return new FilecoinProviderError(
    'filecoin_head_failed',
    'Synapse pieceStatus failed; vendor error suppressed at the provider boundary.',
  );
}

export function wrapSynapseDeleteError(err: unknown): FilecoinProviderError {
  if (err instanceof FilecoinProviderError) return err;
  return new FilecoinProviderError(
    'filecoin_delete_failed',
    'Synapse deletePiece failed; vendor error suppressed at the provider boundary.',
  );
}

export function wrapSynapseStorageInfoError(err: unknown): FilecoinProviderError {
  if (err instanceof FilecoinProviderError) return err;
  return new FilecoinProviderError(
    'filecoin_storage_info_failed',
    'Synapse getStorageInfo failed; vendor error suppressed at the provider boundary.',
  );
}
