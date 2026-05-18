/**
 * @file Vendor-boundary helpers for the filecoin-pin driver.
 *
 * Encapsulates the surface that crosses from our code into
 * `filecoin-pin/core/upload` + `@ipld/car`. The split exists so
 * `filecoin-pin-client.ts` stays focused on the
 * `FilecoinProviderClient` implementation while this file owns:
 *
 *   - The closed minimal type aliases that mirror just the bits
 *     of the vendor shapes we consume.
 *   - The runtime dynamic-import helpers
 *     (`loadExecuteUpload` / `loadCarReader`).
 *   - The noop `Logger`-shaped object we hand to
 *     `executeUpload`'s required `logger` option (so we don't
 *     pull `pino` into the production type graph).
 *
 * Source-build invariant. The production build path
 * (`tsc -p tsconfig.build.json` / `npm run build`) compiles WITHOUT
 * the `optionalDependencies` graph present. Two patterns enforce
 * that here:
 *
 *   1. **Local minimal types.** We do NOT `import type { ... }`
 *      from any optional package. Every shape we consume is
 *      defined locally so `tsc` never has to resolve the vendor
 *      type declarations.
 *
 *   2. **Non-literal dynamic-import specifiers.** Each
 *      `await import(...)` call site uses a `VENDOR_*`
 *      `const`-stored specifier. `tsc` does not statically
 *      resolve a non-literal `import(specifier)` argument, so a
 *      synapse-only install
 *      (`npm ci --legacy-peer-deps --omit=optional`) successfully
 *      runs `tsc -p tsconfig.build.json` even though the optional
 *      modules are absent.
 *
 * The dev-mode `tsc --noEmit` (against `tsconfig.json`) still
 * requires the optional packages because TEST files in
 * `providers/filecoin/__tests__/` import them directly (e.g.
 * `@ipld/car` for a hand-rolled multi-root CAR fixture). Tests
 * never run on omit-optional production installs;
 * `tsconfig.build.json` excludes `__tests__`. See
 * `filecoin-pin-lazy-boundary.test.ts` for the static-import
 * invariant that pins this split.
 */

import type { Synapse } from '@filoz/synapse-sdk';
import type { CID } from 'multiformats/cid';

/** A single SP-side copy result emitted by `executeUpload`. */
export interface MinimalUploadCopy {
  readonly providerId: bigint;
  readonly dataSetId: bigint;
  readonly pieceId: bigint;
  readonly role: 'primary' | 'secondary';
}

/** A single failed-attempt entry emitted by `executeUpload`. */
export interface MinimalUploadFailure {
  readonly providerId: bigint;
  readonly role: 'primary' | 'secondary';
  readonly error: string;
  readonly explicit: boolean;
}

/** The closed subset of `UploadExecutionResult` the driver consumes. */
export interface MinimalUploadResult {
  readonly pieceCid: string;
  readonly copies: ReadonlyArray<MinimalUploadCopy>;
  readonly failedAttempts: ReadonlyArray<MinimalUploadFailure>;
  readonly complete: boolean;
  readonly requestedCopies: number;
}

/** The closed subset of `UploadExecutionOptions` the driver passes. */
export interface MinimalUploadOptions {
  readonly logger: unknown;
  readonly copies?: number;
  readonly providerIds?: ReadonlyArray<bigint>;
  readonly metadata?: Record<string, string>;
  readonly pieceMetadata?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly ipniValidation?: { readonly enabled: boolean };
}

/** Local signature of `filecoin-pin/core/upload.executeUpload`. */
export type ExecuteUploadFn = (
  synapse: Synapse,
  carData: Uint8Array,
  rootCid: CID,
  options: MinimalUploadOptions,
) => Promise<MinimalUploadResult>;

/** Closed subset of `@ipld/car.CarReader` the get-side consumes. */
export interface MinimalCarReader {
  getRoots(): Promise<ReadonlyArray<{ toString(): string }>>;
}

// Specifiers stored as `const`s so `tsc` does not statically
// resolve the optional modules. See file header for the
// source-build-safety rationale.
const VENDOR_FILECOIN_PIN_UPLOAD = 'filecoin-pin/core/upload' as const;
const VENDOR_IPLD_CAR = '@ipld/car' as const;

/**
 * Lazy-load `executeUpload` from `filecoin-pin/core/upload`. The
 * package is in `optionalDependencies`; if a synapse-only build
 * was installed via `npm ci --legacy-peer-deps --omit=optional`,
 * this resolution fails only when an operator selects
 * `RAW_STORAGE_FILECOIN_DRIVER=filecoin_pin` — the intended
 * failure mode.
 */
export async function loadExecuteUpload(): Promise<ExecuteUploadFn> {
  const mod = (await import(VENDOR_FILECOIN_PIN_UPLOAD)) as { executeUpload: ExecuteUploadFn };
  return mod.executeUpload;
}

/** Lazy-load `CarReader.fromBytes` from `@ipld/car`. */
export async function loadCarReader(carBytes: Uint8Array): Promise<MinimalCarReader> {
  const mod = (await import(VENDOR_IPLD_CAR)) as {
    CarReader: { fromBytes(b: Uint8Array): Promise<MinimalCarReader> };
  };
  return mod.CarReader.fromBytes(carBytes);
}

/**
 * Pino-shape silent logger used to satisfy `executeUpload`'s
 * required `logger` option without taking on `pino` as a runtime
 * dep. The `MinimalUploadOptions.logger` field is `unknown` by
 * design so we don't drag pino into the production type graph;
 * the shape below mirrors the closed set of methods filecoin-pin's
 * `executeUpload` actually invokes. If a future filecoin-pin
 * upgrade widens that surface, the runtime call site fails with
 * a clear vendor-side error rather than producing silent test
 * passes against a stale shape.
 */
export function noopLogger(): unknown {
  const noop = (): void => undefined;
  const logger = {
    level: 'silent',
    fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  return logger;
}
