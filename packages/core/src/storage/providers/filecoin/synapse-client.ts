/**
 * @file Synapse-driver implementation of `FilecoinProviderClient`.
 *
 * Wraps a constructed `Synapse` instance and translates the
 * AtomicMemory-shaped boundary onto the SDK surface:
 *
 *   - `put`    → `synapse.storage.upload`
 *   - `get`    → `synapse.storage.download`
 *   - `head`   → `findDataSets` + `createContext` + `pieceStatus`
 *   - `delete` → `findDataSets` + `createContext` + `deletePiece`
 *   - `verify` → `get` + plaintext SHA-256 comparison
 *
 * Vendor types (`UploadResult`, `PieceCID`, `Hash`, ...) stay inside
 * this file; the boundary surface (`FilecoinPutResult`, etc.) is
 * the only shape that escapes the provider package.
 *
 * Sanitization: every Synapse error caught here is replaced with
 * `FilecoinProviderError` + a stable `errorCode`. Raw vendor
 * messages, wallet addresses, payment-rail state, and signed
 * requests do not survive the boundary.
 */

import { createHash } from 'node:crypto';
import type {
  CopyResult,
  FailedAttempt,
  PieceCID,
  PieceStatus,
  UploadResult,
} from '@filoz/synapse-sdk';
import { FilecoinProviderError } from './errors.js';
import {
  wrapSynapseDeleteError,
  wrapSynapseDownloadError,
  wrapSynapseHeadError,
  wrapSynapseStorageInfoError,
  wrapSynapseUploadError,
} from './synapse-error-mapping.js';
import type {
  FilecoinCopySnapshot,
  FilecoinDeleteInput,
  FilecoinDeleteResult,
  FilecoinFailedAttempt,
  FilecoinGetInput,
  FilecoinGetResult,
  FilecoinHeadInput,
  FilecoinHeadResult,
  FilecoinProviderClient,
  FilecoinPutInput,
  FilecoinPutResult,
  FilecoinReadinessCheck,
  FilecoinReadinessNetwork,
  FilecoinVerifyInput,
  FilecoinVerifyResult,
} from './provider-client.js';
import { synapseCheckReadiness, type ReadinessProbeOptions } from './synapse-readiness.js';
import { formatPieceUri, parsePieceUri } from './uri.js';

/**
 * Narrow subset of `Synapse` that `SynapseFilecoinProviderClient`
 * actually depends on. Structural — production code passes the
 * real `Synapse` instance; tests pass a hand-rolled fake exposing
 * only the methods exercised.
 */
export interface SynapseLike {
  readonly storage: SynapseStorageLike;
  readonly chain: SynapseChainLike;
  readonly client: SynapseClientLike;
}

export interface SynapseChainLike {
  readonly id: number | bigint;
}

export interface SynapseClientLike {
  getChainId(): Promise<number | bigint>;
}

export interface SynapseStorageLike {
  upload(data: Uint8Array, options?: SynapseUploadOptionsLike): Promise<UploadResult>;
  download(options: SynapseDownloadOptionsLike): Promise<Uint8Array>;
  findDataSets(options?: { readonly address?: `0x${string}` }): Promise<ReadonlyArray<SynapseDataSetInfoLike>>;
  createContext(options?: SynapseCreateContextOptionsLike): Promise<SynapseContextLike>;
  getStorageInfo(): Promise<SynapseStorageInfoLike>;
  // `getUploadCosts` — non-mutating "ready to upload at this size?"
  // probe. The SDK's full options carry `clientAddress`,
  // `isNewDataSet`, `currentDataSetSize`, `extraRunwayEpochs`,
  // `bufferEpochs`; the StorageManager overload fills the address
  // and readiness only needs `dataSize` + optional `withCDN`. We
  // only consume `ready` from the response; numeric rate/deposit
  // values stay inside the SDK and never cross the boundary.
  getUploadCosts(
    options: { readonly dataSize: bigint; readonly withCDN?: boolean },
  ): Promise<{ readonly ready: boolean }>;
}

export interface SynapseStorageInfoLike {
  readonly providers: ReadonlyArray<SynapseProviderInfoLike>;
  readonly serviceParameters: {
    readonly minUploadSize: number;
    readonly maxUploadSize: number;
  };
  readonly allowances: {
    readonly isApproved: boolean;
    readonly rateAllowance: bigint;
    readonly rateUsed: bigint;
    readonly lockupAllowance: bigint;
    readonly lockupUsed: bigint;
  } | null;
}

export interface SynapseProviderInfoLike {
  readonly id: bigint;
}

export interface SynapseUploadOptionsLike {
  readonly copies?: number;
  readonly providerIds?: ReadonlyArray<bigint>;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly pieceMetadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface SynapseDownloadOptionsLike {
  readonly pieceCid: string | PieceCID;
  readonly withCDN?: boolean;
  readonly signal?: AbortSignal;
}

export interface SynapseCreateContextOptionsLike {
  readonly dataSetId?: bigint;
  readonly providerId?: bigint;
}

export interface SynapseDataSetInfoLike {
  readonly dataSetId: bigint;
  readonly providerId: bigint;
  readonly isLive?: boolean;
}

export interface SynapseContextLike {
  readonly dataSetId: bigint | undefined;
  pieceStatus(options: { readonly pieceCid: string | PieceCID }): Promise<PieceStatus | null>;
  deletePiece(options: { readonly piece: string | PieceCID | bigint }): Promise<`0x${string}`>;
}

/**
 * Per-instance options the production factory threads in from the
 * parsed `FilecoinProviderConfig`. The Synapse SDK takes
 * provider/copy/metadata hints PER UPLOAD CALL, so we hold them on
 * the client and merge with per-input overrides in `put`. The
 * timeout fields are operator-configured defaults wired from
 * `RAW_STORAGE_FILECOIN_UPLOAD_TIMEOUT_MS` and
 * `RAW_STORAGE_FILECOIN_RETRIEVAL_TIMEOUT_MS`; per-call
 * `input.timeoutMs` overrides them when supplied.
 */
export interface SynapseProviderClientOptions {
  readonly copies?: number | null;
  readonly providerIds?: ReadonlyArray<string>;
  readonly dataSetMetadata?: Readonly<Record<string, string>>;
  readonly withCdn?: boolean;
  readonly uploadTimeoutMs?: number | null;
  readonly retrievalTimeoutMs?: number | null;
  /**
   * Configured min/max upload size thresholds from
   * `RAW_STORAGE_FILECOIN_MIN_UPLOAD_BYTES` /
   * `RAW_STORAGE_FILECOIN_MAX_UPLOAD_BYTES`. Used only by
   * `checkReadiness` (`upload_size_bounds_compatible`) —
   * may extend this to also gate `put` at the adapter level.
   */
  readonly minUploadBytes?: number | null;
  readonly maxUploadBytes?: number | null;
}


export class SynapseFilecoinProviderClient implements FilecoinProviderClient {
  readonly provider = 'filecoin' as const;
  readonly driver = 'synapse' as const;

  constructor(
    private readonly synapse: SynapseLike,
    private readonly options: SynapseProviderClientOptions = {},
  ) {}

  async put(input: FilecoinPutInput): Promise<FilecoinPutResult> {
    const effectiveTimeoutMs = input.timeoutMs ?? this.options.uploadTimeoutMs ?? null;
    const controller = effectiveTimeoutMs ? new AbortController() : undefined;
    const timer = controller && effectiveTimeoutMs
      ? setTimeout(() => controller.abort(), effectiveTimeoutMs)
      : undefined;
    try {
      const result = await this.callSynapseUpload(input, controller?.signal);
      return mapUploadResult(result);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async callSynapseUpload(
    input: FilecoinPutInput,
    signal: AbortSignal | undefined,
  ): Promise<UploadResult> {
    const options: SynapseUploadOptionsLike = {
      ...(this.options.copies !== null && this.options.copies !== undefined
        ? { copies: this.options.copies }
        : {}),
      ...(this.options.providerIds && this.options.providerIds.length > 0
        ? { providerIds: this.options.providerIds.map((id) => BigInt(id)) }
        : {}),
      ...(this.options.dataSetMetadata
        ? { metadata: this.options.dataSetMetadata }
        : {}),
      ...(input.pieceMetadata ? { pieceMetadata: input.pieceMetadata } : {}),
      ...(signal ? { signal } : {}),
    };
    try {
      // `Buffer` IS a `Uint8Array` at runtime; cast for the SDK's
      // narrower parameter type.
      return await this.synapse.storage.upload(input.body as Uint8Array, options);
    } catch (err) {
      throw wrapSynapseUploadError(err, signal);
    }
  }

  async get(input: FilecoinGetInput): Promise<FilecoinGetResult> {
    const pieceCid = parsePieceUri(input.storageUri);
    const effectiveTimeoutMs = input.timeoutMs ?? this.options.retrievalTimeoutMs ?? null;
    const controller = effectiveTimeoutMs ? new AbortController() : undefined;
    const timer = controller && effectiveTimeoutMs
      ? setTimeout(() => controller.abort(), effectiveTimeoutMs)
      : undefined;
    try {
      const bytes = await this.callSynapseDownload(pieceCid, controller?.signal);
      return {
        body: Buffer.from(bytes),
        providerMetadata: { piece_cid: pieceCid },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async callSynapseDownload(
    pieceCid: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const opts: SynapseDownloadOptionsLike = {
      pieceCid,
      ...(this.options.withCdn !== undefined ? { withCDN: this.options.withCdn } : {}),
      ...(signal ? { signal } : {}),
    };
    try {
      return await this.synapse.storage.download(opts);
    } catch (err) {
      throw wrapSynapseDownloadError(err, signal);
    }
  }

  async head(input: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    const pieceCid = parsePieceUri(input.storageUri);
    try {
      const status = await this.locatePieceStatus(pieceCid, input.dataSetId);
      if (status === null) {
        return {
          exists: false,
          proven: false,
          providerMetadata: { piece_cid: pieceCid },
        };
      }
      return {
        exists: true,
        proven: status.dataSetLastProven !== null,
        providerMetadata: buildHeadMetadata(pieceCid, status),
      };
    } catch (err) {
      throw wrapSynapseHeadError(err);
    }
  }

  async delete(input: FilecoinDeleteInput): Promise<FilecoinDeleteResult> {
    const pieceCid = parsePieceUri(input.storageUri);
    try {
      const context = await this.locateContext(pieceCid, input.dataSetId);
      if (context === null) {
        // Piece not found in any data set the signer owns — treat
        // as already-removed under tombstone semantics. The
        // reconciler/cleanup path is idempotent on this.
        return { deleted: false, semantics: 'tombstone' };
      }
      // Prefer the explicit per-copy `piece_id` from the upload
      // sidecar when the caller supplied it. Synapse's
      // `deletePiece({ piece: pieceCid })` resolves the piece via
      // PDP active-piece lookup, which cannot complete for
      // freshly-uploaded calibration pieces before proof lands.
      // `BigInt(pieceId)` short-circuits the lookup and deletes
      // by id directly. CID fallback stays for callers (and
      // legacy rows) that don't carry the sidecar piece_id yet.
      const pieceForDelete: string | bigint = input.pieceId !== undefined
        ? toPieceIdBigIntOrThrow(input.pieceId)
        : pieceCid;
      const txHash = await context.deletePiece({ piece: pieceForDelete });
      return { deleted: true, semantics: 'tombstone', txHash };
    } catch (err) {
      throw wrapSynapseDeleteError(err);
    }
  }

  async checkReadiness(
    network: FilecoinReadinessNetwork,
  ): Promise<ReadonlyArray<FilecoinReadinessCheck>> {
    return synapseCheckReadiness(this.synapse, this.readinessOptions(), network);
  }

  /**
   * Non-mutating SDK read of the service-advertised minimum
   * upload size in bytes. Exposed for preflight/sizing callers
   * (e.g. the live calibration smoke test) that need to size
   * payloads against the provider's real contract rather than a
   * baked-in constant. Errors map onto
   * `filecoin_storage_info_failed`; vendor strings stay inside.
   */
  async getServiceMinUploadBytes(): Promise<number> {
    try {
      const info = await this.synapse.storage.getStorageInfo();
      return info.serviceParameters.minUploadSize;
    } catch (err) {
      throw wrapSynapseStorageInfoError(err);
    }
  }

  private readinessOptions(): ReadinessProbeOptions {
    return {
      providerIds: this.options.providerIds ?? [],
      minUploadBytes: this.options.minUploadBytes ?? null,
      maxUploadBytes: this.options.maxUploadBytes ?? null,
      ...(this.options.withCdn !== undefined ? { withCdn: this.options.withCdn } : {}),
    };
  }

  async verify(input: FilecoinVerifyInput): Promise<FilecoinVerifyResult> {
    let body: Buffer;
    try {
      const got = await this.get({
        storageUri: input.storageUri,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      body = got.body;
    } catch (err) {
      if (err instanceof FilecoinProviderError) {
        return { verified: false, reason: err.errorCode };
      }
      return { verified: false, reason: 'filecoin_verify_failed' };
    }
    const actualHash = createHash('sha256').update(body).digest('hex');
    if (actualHash === input.expectedContentHash) {
      return { verified: true };
    }
    return { verified: false, reason: 'content_hash_mismatch' };
  }

  /**
   * Resolve the StorageContext that holds `pieceCid`. When the
   * caller supplied `dataSetIdHint`, build a context for that
   * specific data set; otherwise iterate the signer's data sets via
   * `findDataSets` and probe each with `pieceStatus`. Returns the
   * first context whose `pieceStatus` is non-null.
   */
  private async locateContext(
    pieceCid: string,
    dataSetIdHint: string | undefined,
  ): Promise<SynapseContextLike | null> {
    if (dataSetIdHint !== undefined) {
      const dataSetId = toBigIntOrThrow(dataSetIdHint, 'filecoin_invalid_data_set_id');
      const context = await this.synapse.storage.createContext({ dataSetId });
      const status = await context.pieceStatus({ pieceCid });
      return status === null ? null : context;
    }
    const dataSets = await this.synapse.storage.findDataSets();
    for (const info of dataSets) {
      if (info.isLive === false) continue;
      const context = await this.synapse.storage.createContext({ dataSetId: info.dataSetId });
      const status = await context.pieceStatus({ pieceCid });
      if (status !== null) return context;
    }
    return null;
  }

  /**
   * Variant of `locateContext` that returns the `PieceStatus`
   * directly. Used by `head` so the caller doesn't have to issue a
   * second `pieceStatus` call to read the status it already
   * located.
   */
  private async locatePieceStatus(
    pieceCid: string,
    dataSetIdHint: string | undefined,
  ): Promise<PieceStatus | null> {
    if (dataSetIdHint !== undefined) {
      const dataSetId = toBigIntOrThrow(dataSetIdHint, 'filecoin_invalid_data_set_id');
      const context = await this.synapse.storage.createContext({ dataSetId });
      return context.pieceStatus({ pieceCid });
    }
    const dataSets = await this.synapse.storage.findDataSets();
    for (const info of dataSets) {
      if (info.isLive === false) continue;
      const context = await this.synapse.storage.createContext({ dataSetId: info.dataSetId });
      const status = await context.pieceStatus({ pieceCid });
      if (status !== null) return status;
    }
    return null;
  }
}

/**
 * Project the Synapse `UploadResult` onto the AtomicMemory
 * `FilecoinPutResult` boundary. The transformation is total —
 * every input field maps to a documented output field; vendor
 * types (`PieceCID`, `bigint`) are stringified at the boundary so
 * the result is JSON-safe.
 */
function mapUploadResult(result: UploadResult): FilecoinPutResult {
  const pieceCid = stringifyPieceCid(result.pieceCid);
  return {
    pieceCid,
    storageUri: formatPieceUri(pieceCid),
    sizeBytes: result.size,
    copies: result.copies.map(toCopySnapshot),
    failedAttempts: result.failedAttempts.map(toFailedAttempt),
    complete: result.complete,
    requestedCopies: result.requestedCopies,
  };
}

function stringifyPieceCid(pieceCid: PieceCID): string {
  // `PieceCID` is a `Link` from `multiformats`; its `.toString()`
  // emits the canonical base32 representation. Defensive in case a
  // future SDK release introduces a different runtime shape.
  if (typeof pieceCid === 'string') return pieceCid;
  if (pieceCid && typeof (pieceCid as { toString: () => string }).toString === 'function') {
    return (pieceCid as { toString: () => string }).toString();
  }
  throw new FilecoinProviderError(
    'filecoin_invalid_piece_cid',
    'Synapse upload returned an unserializable PieceCID.',
  );
}

function toCopySnapshot(copy: CopyResult): FilecoinCopySnapshot {
  return {
    providerId: copy.providerId.toString(),
    dataSetId: copy.dataSetId.toString(),
    pieceId: copy.pieceId.toString(),
    role: copy.role,
  };
}

function toFailedAttempt(attempt: FailedAttempt): FilecoinFailedAttempt {
  return {
    providerId: attempt.providerId.toString(),
    role: attempt.role,
    errorCode: 'filecoin_copy_failed',
    explicit: attempt.explicit,
  };
}

/**
 * Build the head-result metadata returned to the adapter. Synapse's
 * `PieceStatus.retrievalUrl` is intentionally NOT included: it is
 * an arbitrary provider URL whose public exposure / persistence
 * would violate the plan's CDN/SSRF rule (no arbitrary provider
 * URLs on public or persisted paths). The bounded fields below are
 * all derived state (`piece_cid`, proof timestamps, challenge-
 * window flags) that the reconciler can act on without ever
 * needing the URL.
 */
function buildHeadMetadata(
  pieceCid: string,
  status: PieceStatus,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { piece_cid: pieceCid };
  if (status.dataSetLastProven !== null && status.dataSetLastProven !== undefined) {
    meta['data_set_last_proven_at'] = status.dataSetLastProven.toISOString();
  }
  if (status.inChallengeWindow !== undefined) {
    meta['in_challenge_window'] = status.inChallengeWindow;
  }
  if (status.isProofOverdue !== undefined) {
    meta['proof_overdue'] = status.isProofOverdue;
  }
  return meta;
}

function toBigIntOrThrow(value: string, errorCode: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new FilecoinProviderError(errorCode, `Filecoin id '${value}' is not a valid bigint.`);
  }
}

/**
 * Strict positive-decimal-bigint parser for the `piece_id` field
 * accepted by `delete`. The hint reader at the adapter layer
 * already filters malformed values, but defense-in-depth: a
 * caller passing the value directly (bypassing hints) still gets
 * a sanitized rejection. The error message is fixed — the
 * rejected value NEVER leaks across the boundary.
 */
function toPieceIdBigIntOrThrow(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new FilecoinProviderError(
      'filecoin_invalid_piece_id',
      'FilecoinDeleteInput.pieceId must be a positive decimal bigint string.',
    );
  }
  return BigInt(value);
}
