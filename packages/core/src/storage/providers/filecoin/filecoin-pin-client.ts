/**
 * @file `FilecoinProviderClient` implementation backed by the
 * `filecoin-pin` package (the Filecoin Project's reference CAR-
 * first upload pipeline).
 *
 * Composition strategy: this client OWNS the `put`, `get`, and
 * `verify` paths (the three seams where the CAR-first wrapper
 * differs from direct Synapse) and DELEGATES every other method
 * to a `SynapseFilecoinProviderClient` instance built off the
 * same `Synapse` handle. `head`, `delete`, `checkReadiness`,
 * and `getServiceMinUploadBytes` reach Synapse SDK calls that the
 * direct driver already implements correctly — re-implementing
 * them here would duplicate code and risk drifting semantics.
 *
 * Sibling helpers split the implementation along three seams:
 *
 *   - `filecoin-pin-vendor.ts` — vendor minimal types +
 *     `loadExecuteUpload` / `loadCarReader` dynamic-import
 *     loaders + `noopLogger`. Owns the
 *     `optionalDependencies`-safe vendor boundary.
 *   - `filecoin-pin-timeout.ts` — `makeTimeoutHandle` (cancellable
 *     timeout sentinel for `put`'s `Promise.race`).
 *   - `filecoin-pin-mapping.ts` — `buildCarOrThrow`,
 *     `buildUploadOptions`, `mapCopies` / `mapFailedAttempts` /
 *     `mapPutResult` / `mapPutFailure`. Vendor→provider-neutral
 *     wire-shape translation.
 *
 * Why delegate `head`/`delete` to the direct driver:
 *   - `filecoin-pin` does not ship a dedicated head/delete
 *     surface. Both the direct and CAR-first paths ultimately
 *     call the same Synapse SDK primitives (`pieceStatus`,
 *     `deletePiece`), so delegation preserves the Phase 3/4
 *     contracts (canonical PieceCID identity, sanitized errors,
 *     piece-id hinted delete) without copy-paste.
 *   - Delete semantics: the Synapse delegate returns the existing
 *     provider tombstone behaviour. The plan calls for "weaker
 *     semantics" if the new driver cannot match — it CAN match,
 *     so we return the same `tombstone` value the direct driver
 *     produces.
 *
 * Why `put`/`get`/`verify` are owned here:
 *   - `put` builds a UnixFS DAG from the input bytes, serialises
 *     to a CAR, and hands the CAR to filecoin-pin's
 *     `executeUpload`. The IPFS root CID is captured and surfaced
 *     as the optional Phase 4 `ipfsCid` field — that is the
 *     concrete value-add of the filecoin-pin path over direct
 *     Synapse.
 *   - `get` reverses the wrapper: download the CAR via the same
 *     Synapse retrieval path the delegate uses, require the CAR
 *     to declare exactly one root (a multi-root CAR is malformed
 *     for our put-side contract and is rejected as
 *     `filecoin_pin_car_ambiguous_roots`; a stale sidecar must
 *     not redirect retrieval either), and walk the UnixFS DAG to
 *     recover the original bytes. The wire-level `get` contract
 *     still says "return the bytes that were put".
 *   - `verify` overrides the delegate's `verify` because the
 *     Synapse-side path would hash CAR bytes, but the upload
 *     pipeline recorded a plaintext SHA-256. The override runs
 *     through THIS client's `get` and hashes the extracted
 *     plaintext. `input.timeoutMs` flows through to the
 *     retrieval so verify stays bounded the same way direct
 *     Synapse verify is bounded.
 *
 * Vendor isolation: every static value/type import of an
 * optional package lives behind the helpers above. The
 * `filecoin-pin-lazy-boundary.test.ts` static-import scan asserts
 * NO production source file in `providers/filecoin/` statically
 * imports `filecoin-pin/*`, `@helia/*`, `@ipld/car`,
 * `blockstore-core`, or `pino`. `tsc -p tsconfig.build.json`
 * passes against a synapse-only install (`npm ci
 * --legacy-peer-deps --omit=optional`).
 */

import { createHash } from 'node:crypto';
import type { Synapse } from '@filoz/synapse-sdk';
import { CID } from 'multiformats/cid';
import { FilecoinProviderError } from './errors.js';
import { extractFileFromCar } from './filecoin-pin-car.js';
import {
  buildCarOrThrow,
  buildUploadOptions,
  mapPutFailure,
  mapPutResult,
  type FilecoinPinClientOptions,
} from './filecoin-pin-mapping.js';
import { makeTimeoutHandle, type TimeoutHandle } from './filecoin-pin-timeout.js';
import { loadCarReader, loadExecuteUpload } from './filecoin-pin-vendor.js';
import type { SynapseFilecoinProviderClient } from './synapse-client.js';
import type {
  FilecoinDeleteInput,
  FilecoinDeleteResult,
  FilecoinGetInput,
  FilecoinGetResult,
  FilecoinHeadInput,
  FilecoinHeadResult,
  FilecoinProviderClient,
  FilecoinPutInput,
  FilecoinPutResult,
  FilecoinReadinessCheck,
  FilecoinVerifyInput,
  FilecoinVerifyResult,
} from './provider-client.js';

export type { FilecoinPinClientOptions } from './filecoin-pin-mapping.js';

export class FilecoinPinFilecoinProviderClient implements FilecoinProviderClient {
  readonly provider = 'filecoin' as const;
  readonly driver = 'filecoin_pin' as const;

  constructor(
    private readonly synapse: Synapse,
    private readonly synapseDelegate: SynapseFilecoinProviderClient,
    private readonly options: FilecoinPinClientOptions = {},
  ) {}

  async put(input: FilecoinPutInput): Promise<FilecoinPutResult> {
    const built = await buildCarOrThrow(input.body);
    const timeoutMs = input.timeoutMs ?? this.options.uploadTimeoutMs;
    const aborter = timeoutMs !== undefined && timeoutMs > 0 ? new AbortController() : null;
    const uploadOptions = buildUploadOptions(this.options, input, aborter);
    const executeUpload = await loadExecuteUpload();
    const uploadPromise = executeUpload(this.synapse, built.carBytes, built.rootCid, uploadOptions);
    const timeoutHandle: TimeoutHandle | null =
      aborter !== null && timeoutMs !== undefined
        ? makeTimeoutHandle(timeoutMs, aborter)
        : null;
    try {
      const result = timeoutHandle !== null
        ? await Promise.race([uploadPromise, timeoutHandle.promise])
        : await uploadPromise;
      return mapPutResult(result, built);
    } catch (err) {
      throw mapPutFailure(err, aborter, timeoutMs);
    } finally {
      timeoutHandle?.cancel();
    }
  }

  async get(input: FilecoinGetInput): Promise<FilecoinGetResult> {
    const carResult = await this.synapseDelegate.get(input);
    let rootCid: CID;
    try {
      const reader = await loadCarReader(carResult.body);
      const roots = await reader.getRoots();
      if (roots.length === 0) {
        throw new FilecoinProviderError(
          'filecoin_pin_car_no_root',
          'Retrieved CAR carries no root CID; cannot extract the original file.',
        );
      }
      if (roots.length > 1) {
        // `buildCarFromBytes` emits exactly one root. A retrieved
        // CAR declaring multiple roots is either malformed or a
        // crafted payload trying to redirect retrieval — refuse to
        // silently pick the first.
        throw new FilecoinProviderError(
          'filecoin_pin_car_ambiguous_roots',
          'Retrieved CAR declares multiple roots; filecoin-pin uploads emit exactly one.',
        );
      }
      // Re-parse the root string through the canonical
      // `multiformats/cid` so we hand the unixfs walker an
      // instance with the prototype methods it expects (the
      // `@ipld/car`-nested multiformats and the top-level one
      // structurally match at runtime but are TS-distinct types).
      rootCid = CID.parse(roots[0]!.toString());
    } catch (err) {
      if (err instanceof FilecoinProviderError) throw err;
      throw new FilecoinProviderError(
        'filecoin_pin_car_parse_failed',
        'filecoin-pin driver could not parse the retrieved CAR.',
      );
    }
    let bytes: Buffer;
    try {
      bytes = await extractFileFromCar(carResult.body, rootCid);
    } catch {
      throw new FilecoinProviderError(
        'filecoin_pin_car_extract_failed',
        'filecoin-pin driver could not extract the file from the retrieved CAR.',
      );
    }
    return {
      body: bytes,
      providerMetadata: { ...carResult.providerMetadata, ipfs_cid: rootCid.toString() },
    };
  }

  async head(input: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    return this.synapseDelegate.head(input);
  }

  async delete(input: FilecoinDeleteInput): Promise<FilecoinDeleteResult> {
    return this.synapseDelegate.delete(input);
  }

  async verify(input: FilecoinVerifyInput): Promise<FilecoinVerifyResult> {
    // Phase 5 blocker fix: the Synapse delegate's `verify` hashes
    // whatever bytes Synapse returned for the PieceCID. Under
    // filecoin-pin those bytes are CAR bytes, NOT the original
    // plaintext, so the delegate's hash would always mismatch
    // `expectedContentHash` (which is the plaintext SHA-256
    // computed at upload time). Run `verify` through THIS client's
    // `get` — that unwraps the CAR and hashes the extracted
    // plaintext, matching the upload-side hash contract.
    // `input.timeoutMs` flows through to the retrieval so verify
    // stays bounded the same way the direct Synapse verify is
    // bounded.
    let body: Buffer;
    try {
      const fetched = await this.get({
        storageUri: input.storageUri,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
      body = fetched.body;
    } catch (err) {
      // Surface retrieval/parse failures as a typed `verify`
      // outcome rather than a raw throw; the reconciler relies
      // on `verified=false + reason` to drive retries.
      const reason =
        err instanceof FilecoinProviderError ? err.errorCode : 'filecoin_pin_verify_get_failed';
      return { verified: false, reason };
    }
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== input.expectedContentHash) {
      return { verified: false, reason: 'content_hash_mismatch' };
    }
    return { verified: true };
  }

  async checkReadiness(network: 'calibration' | 'mainnet'): Promise<ReadonlyArray<FilecoinReadinessCheck>> {
    return this.synapseDelegate.checkReadiness(network);
  }

  async getServiceMinUploadBytes(): Promise<number> {
    return this.synapseDelegate.getServiceMinUploadBytes();
  }
}
