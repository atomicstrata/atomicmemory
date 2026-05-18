/**
 * @file Result-shape mapping + option builder for the
 * filecoin-pin driver's `put` path.
 *
 * Lifted out of `filecoin-pin-client.ts` to keep the client
 * focused on the `FilecoinProviderClient` implementation and
 * this file focused on the wire-shape translation between the
 * vendor's `MinimalUploadResult` and our provider-neutral
 * `FilecoinPutResult`. The closed set of helpers here:
 *
 *   - `buildCarOrThrow` — sanitised wrapper around `buildCarFromBytes`.
 *   - `buildUploadOptions` — assemble the `executeUpload`
 *     option bag with explicit conditional spreads so each
 *     field is either present-with-meaning or absent (no
 *     `undefined`-valued slots).
 *   - `mapCopies` / `mapFailedAttempts` — vendor→provider-neutral
 *     copy/failure shape, omitting non-positive piece IDs.
 *   - `mapPutResult` — build the `FilecoinPutResult` shape from
 *     the vendor `MinimalUploadResult` + built CAR.
 *   - `mapPutFailure` — classify a `put`-path error into the
 *     closed set of typed `FilecoinProviderError`s.
 *
 * No vendor module is statically imported here; the file
 * type-checks under the production build path even when the
 * `optionalDependencies` graph is absent.
 */

import type { CID } from 'multiformats/cid';
import { FilecoinProviderError } from './errors.js';
import { buildCarFromBytes } from './filecoin-pin-car.js';
import type {
  MinimalUploadCopy,
  MinimalUploadFailure,
  MinimalUploadOptions,
  MinimalUploadResult,
} from './filecoin-pin-vendor.js';
import { noopLogger } from './filecoin-pin-vendor.js';
import type {
  FilecoinCopySnapshot,
  FilecoinFailedAttempt,
  FilecoinPutInput,
  FilecoinPutResult,
} from './provider-client.js';

export interface FilecoinPinClientOptions {
  readonly copies?: number;
  readonly providerIds?: ReadonlyArray<string>;
  readonly dataSetMetadata?: Record<string, string>;
  readonly uploadTimeoutMs?: number;
  readonly retrievalTimeoutMs?: number;
  readonly minUploadBytes?: number | null;
  readonly maxUploadBytes?: number | null;
}

export async function buildCarOrThrow(body: Buffer): Promise<{ carBytes: Buffer; rootCid: CID }> {
  try {
    return await buildCarFromBytes(body);
  } catch {
    throw new FilecoinProviderError(
      'filecoin_pin_car_build_failed',
      'filecoin-pin driver failed to wrap upload bytes into a CAR.',
    );
  }
}

/**
 * Assemble the option bag we hand to `executeUpload`. The bag is
 * built with explicit conditional spreads so each field is either
 * present-with-meaning or absent — no `undefined`-valued slots
 * that would force the SDK to apply defaults differently from how
 * the direct driver applies them. IPNI announcement validation is
 * always disabled here: `put` returns once the CAR is stored, and
 * the IPNI lookup is a separate network-side concern.
 */
export function buildUploadOptions(
  options: FilecoinPinClientOptions,
  input: FilecoinPutInput,
  aborter: AbortController | null,
): MinimalUploadOptions {
  const providerIds = options.providerIds?.map((id) => BigInt(id));
  return {
    logger: noopLogger(),
    ...(options.copies !== undefined ? { copies: options.copies } : {}),
    ...(providerIds !== undefined && providerIds.length > 0 ? { providerIds } : {}),
    ...(options.dataSetMetadata !== undefined ? { metadata: options.dataSetMetadata } : {}),
    ...(input.pieceMetadata !== undefined ? { pieceMetadata: { ...input.pieceMetadata } } : {}),
    ...(aborter !== null ? { signal: aborter.signal } : {}),
    ipniValidation: { enabled: false },
  };
}

function mapCopies(
  copies: ReadonlyArray<MinimalUploadCopy>,
): ReadonlyArray<FilecoinCopySnapshot> {
  return copies.map((c) => ({
    providerId: c.providerId.toString(),
    dataSetId: c.dataSetId.toString(),
    // Only carry a positive bigint as the piece-id hint —
    // filecoin-pin's `executeUpload` returns `0n` for copies
    // accepted at the SP but not yet confirmed at the data-set,
    // and persisting `'0'` would trip the hint reader's
    // positive-decimal-bigint validator. Omitting the field
    // routes delete through the CID-lookup fallback cleanly.
    ...(c.pieceId > 0n ? { pieceId: c.pieceId.toString() } : {}),
    role: c.role,
  }));
}

function mapFailedAttempts(
  attempts: ReadonlyArray<MinimalUploadFailure>,
): ReadonlyArray<FilecoinFailedAttempt> {
  // Sanitisation: NEVER pipe the raw vendor `error` string into
  // the public shape. The closed `errorCode` is what surfaces;
  // the original message stays inside the driver.
  return attempts.map((a) => ({
    providerId: a.providerId.toString(),
    role: a.role,
    errorCode: 'filecoin_pin_copy_failed',
    explicit: a.explicit,
  }));
}

export function mapPutResult(
  result: MinimalUploadResult,
  built: { carBytes: Buffer; rootCid: CID },
): FilecoinPutResult {
  return {
    pieceCid: result.pieceCid,
    storageUri: `filecoin://piece/${result.pieceCid}`,
    sizeBytes: built.carBytes.length,
    copies: mapCopies(result.copies),
    failedAttempts: mapFailedAttempts(result.failedAttempts),
    complete: result.complete,
    requestedCopies: result.requestedCopies,
    ipfsCid: built.rootCid.toString(),
  };
}

export function mapPutFailure(
  err: unknown,
  aborter: AbortController | null,
  timeoutMs: number | undefined,
): FilecoinProviderError {
  if (err instanceof FilecoinProviderError) return err;
  if (aborter?.signal.aborted) {
    return new FilecoinProviderError(
      'filecoin_pin_upload_timeout',
      `filecoin-pin driver aborted CAR upload after ${timeoutMs} ms.`,
    );
  }
  return new FilecoinProviderError(
    'filecoin_pin_upload_failed',
    'filecoin-pin driver failed to upload the CAR to Synapse.',
  );
}
