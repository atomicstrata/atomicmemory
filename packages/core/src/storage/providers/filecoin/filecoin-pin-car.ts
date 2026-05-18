/**
 * @file CAR-construction helpers for the filecoin-pin driver.
 *
 * The filecoin-pin path differs from the direct Synapse driver in
 * one place: before handing bytes to the Synapse SDK it wraps them
 * in a CAR file whose blocks form an IPFS UnixFS DAG. The Filecoin
 * PieceCID is then computed over the CAR bytes (not the raw user
 * content), and the IPFS root CID survives as a separate
 * identifier — which is the value the Phase 4 `ipfs_cid` sidecar
 * slot was designed to carry.
 *
 * Two seams live here:
 *
 *   - `buildCarFromBytes(body)` — convert a `Buffer` of raw user
 *     bytes into a `{ carBytes, rootCid }` pair via Helia +
 *     `@helia/unixfs`. Used by `FilecoinPinFilecoinProviderClient.put`
 *     immediately before delegating to filecoin-pin's
 *     `executeUpload`.
 *
 *   - `extractFileFromCar(carBytes, rootCid)` — the inverse:
 *     parse a CAR by streaming its blocks back into an in-memory
 *     blockstore, then unixfs-traverse from the root to materialise
 *     the original bytes. Used by
 *     `FilecoinPinFilecoinProviderClient.get` to reverse the CAR
 *     wrapping the upload path applied.
 *
 * Vendor isolation. Every CAR / Helia / blockstore import lives
 * inside the function bodies as a runtime `await import(...)`
 * against a `const`-stored specifier. That makes this file
 * source-build-safe without the `optionalDependencies` graph
 * present — the production build path
 * (`tsc -p tsconfig.build.json` / `npm run build`) compiles even
 * when none of `@ipld/car`, `@helia/unixfs`, or `blockstore-core`
 * are installed. Local minimal type aliases below mirror just
 * the surface we consume. (Dev-mode `tsc --noEmit` against the
 * full `tsconfig.json` still requires the optional packages
 * because TEST files import them directly — tests never run on
 * omit-optional production installs; `tsconfig.build.json`
 * excludes `__tests__`.) The runtime dynamic-import is the only
 * resolution call site, so a synapse-only install
 * (`npm ci --legacy-peer-deps --omit=optional`) never touches
 * the CAR-first modules.
 *
 * Errors are not thrown directly from this file. The driver
 * client wraps any failure into a typed
 * `FilecoinProviderError('filecoin_pin_car_*', sanitized)` at the
 * call site so vendor stack traces never escape the boundary.
 */

import { CID } from 'multiformats/cid';

export interface BuiltCar {
  /** Serialized CAR bytes — what the upload path hands to Synapse. */
  readonly carBytes: Buffer;
  /** IPFS root CID (unixfs dag-pb / raw, CIDv1 base32). */
  readonly rootCid: CID;
}

// Local minimal mirrors of the vendor shapes — see the file
// header for why these are not `import type { ... }` from the
// optional packages.
interface CarWriterPair {
  readonly cid: unknown;
  readonly bytes: Uint8Array;
}
interface CarWriterHandle {
  put(pair: CarWriterPair): Promise<void>;
  close(): Promise<void>;
}
interface CarWriterModule {
  create(roots: ReadonlyArray<unknown>): { writer: CarWriterHandle; out: AsyncIterable<Uint8Array> };
}
interface CarReaderHandle {
  blocks(): AsyncIterable<{ cid: unknown; bytes: Uint8Array }>;
}
interface CarReaderModule {
  fromBytes(b: Uint8Array): Promise<CarReaderHandle>;
}
interface UnixFsLike {
  addBytes(b: Uint8Array): Promise<CID>;
  cat(c: CID): AsyncIterable<Uint8Array>;
}
interface BlockstorePair {
  readonly cid: unknown;
  readonly bytes: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}
interface BlockstoreLike {
  put(cid: unknown, bytes: Uint8Array): Promise<void>;
  getAll(): AsyncIterable<BlockstorePair>;
}

// The specifiers below are stored as runtime values rather than
// inline string literals so `tsc` does NOT statically resolve the
// optional modules at type-check time. A synapse-only install
// (`npm ci --legacy-peer-deps --omit=optional`) successfully
// runs `tsc -p tsconfig.build.json`; the dynamic import only
// fails at runtime when an operator selects
// `RAW_STORAGE_FILECOIN_DRIVER=filecoin_pin` without the optional
// graph installed — which is the intended failure mode.
const VENDOR_IPLD_CAR = '@ipld/car' as const;
const VENDOR_HELIA_UNIXFS = '@helia/unixfs' as const;
const VENDOR_BLOCKSTORE_MEMORY = 'blockstore-core/memory' as const;

async function loadCarWriter(): Promise<CarWriterModule> {
  const mod = (await import(VENDOR_IPLD_CAR)) as unknown as { CarWriter: CarWriterModule };
  return mod.CarWriter;
}
async function loadCarReader(): Promise<CarReaderModule> {
  const mod = (await import(VENDOR_IPLD_CAR)) as unknown as { CarReader: CarReaderModule };
  return mod.CarReader;
}
async function loadUnixfs(blockstore: BlockstoreLike): Promise<UnixFsLike> {
  const mod = (await import(VENDOR_HELIA_UNIXFS)) as unknown as {
    unixfs: (opts: { blockstore: BlockstoreLike }) => UnixFsLike;
  };
  return mod.unixfs({ blockstore });
}
async function loadMemoryBlockstore(): Promise<BlockstoreLike> {
  const mod = (await import(VENDOR_BLOCKSTORE_MEMORY)) as unknown as {
    MemoryBlockstore: new () => BlockstoreLike;
  };
  return new mod.MemoryBlockstore();
}

/**
 * Flatten the blockstore's per-block byte iterable into a single
 * `Uint8Array`. `MemoryBlockstore.getAll()` reports `bytes` as
 * an `AwaitGenerator<Uint8Array>` even though concrete blocks are
 * usually single-chunk; we collect whichever shape arrives.
 */
async function flattenBytes(value: Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const chunks: Uint8Array[] = [];
  for await (const chunk of value as AsyncIterable<Uint8Array>) chunks.push(chunk);
  if (chunks.length === 1) return new Uint8Array(chunks[0]!);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Build a single-file UnixFS DAG from `body`, then serialise it
 * as a CAR with the file's root as the sole CAR root. The
 * returned `rootCid` is the canonical IPFS identity for the
 * bytes — pass it through to `FilecoinPutResult.ipfsCid` so the
 * sidecar carries a stable IPFS handle alongside the Filecoin
 * PieceCID.
 */
export async function buildCarFromBytes(body: Buffer): Promise<BuiltCar> {
  const blockstore = await loadMemoryBlockstore();
  const fs = await loadUnixfs(blockstore);
  const rootCid = await fs.addBytes(body);
  const CarWriter = await loadCarWriter();
  const { writer, out } = CarWriter.create([rootCid]);
  const collected: Uint8Array[] = [];
  const collecting = (async () => {
    for await (const chunk of out) collected.push(chunk);
  })();
  try {
    for await (const pair of blockstore.getAll()) {
      const bytes = await flattenBytes(pair.bytes);
      await writer.put({ cid: pair.cid, bytes });
    }
  } finally {
    await writer.close();
  }
  await collecting;
  return { carBytes: Buffer.concat(collected), rootCid };
}

/**
 * Inverse of `buildCarFromBytes`: parse `carBytes` into an in-
 * memory blockstore, then walk the UnixFS DAG from `rootCid` to
 * recover the original file bytes. Returns a `Buffer` matching
 * what was originally uploaded.
 *
 * `rootCid` may be passed as either a `multiformats/cid.CID`
 * instance or its canonical string form. We accept the string
 * form so callers that derived the root from `CarReader.getRoots()`
 * (whose CID type lives in `@ipld/car`'s nested `multiformats`,
 * not the top-level one) can interoperate without a manual
 * cross-package cast.
 */
export async function extractFileFromCar(
  carBytes: Buffer,
  rootCid: CID | string,
): Promise<Buffer> {
  const CarReader = await loadCarReader();
  const reader = await CarReader.fromBytes(carBytes);
  const blockstore = await loadMemoryBlockstore();
  for await (const { cid, bytes } of reader.blocks()) {
    await blockstore.put(cid, bytes);
  }
  // Re-parse the root through the canonical `multiformats/cid`
  // so the unixfs walker receives an instance with the prototype
  // methods the helia/unixfs side expects. Avoids a "method does
  // not exist" runtime failure when callers hand us a CID from
  // `@ipld/car`'s nested multiformats version.
  const canonicalRoot = CID.parse(typeof rootCid === 'string' ? rootCid : rootCid.toString());
  const fs = await loadUnixfs(blockstore);
  const chunks: Uint8Array[] = [];
  for await (const chunk of fs.cat(canonicalRoot)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
