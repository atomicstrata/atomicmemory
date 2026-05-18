/**
 * @file First end-to-end live Filecoin/Synapse smoke test. Opt-in.
 *
 * Goes through the SAME provider boundary that production uses:
 *   - `parseFilecoinProviderConfig(process.env)` →
 *     `createFilecoinStorageBackend(config)` returns a
 *     `RawContentStore` exactly as `src/storage/factory.ts` does at
 *     runtime. Readiness uses the factory's internal primitives
 *     (`buildSynapse` + `SynapseFilecoinProviderClient`) because the
 *     `RawContentStore` adapter does not expose `checkReadiness` —
 *     production does not yet surface readiness either.
 *
 * Gates:
 *   - `FILECOIN_LIVE_TESTS=1`         enables the suite
 *   - `FILECOIN_LIVE_TEST_MAX_WAIT_MS` upper-bound for proof
 *     polling. `0` (default) skips the proof + get tier. When >0
 *     the proof poll runs until `exists=true` OR the cap elapses;
 *     a failure to land within the cap is a HARD failure with a
 *     sanitized message (no fixed sleep + assert pattern).
 *   - `FILECOIN_LIVE_TEST_LARGER_BYTES` opt-in second-payload size.
 *     When >0, runs the harvest-plan §Phase 8 "larger object"
 *     regression: a SECOND upload of that many bytes through the
 *     same provider, then `get()` + SHA-256 verification, then
 *     `afterAll` deletes it alongside the minimum-size piece. `0`
 *     (default) skips this tier so the smoke stays cheap; raise it
 *     only when calibration USDFC allowance / provider PDP limits
 *     can afford a second piece in the same run.
 *
 * What the suite asserts (in declaration order, share-state via
 * `beforeAll`):
 *   1. Readiness probe returns the documented check list against a
 *      real calibration RPC.
 *   2. Upload at the resolved minimum upload size —
 *      `provider.config.minUploadBytes ?? SIZE_CONSTANTS.MIN_UPLOAD_SIZE`
 *      so an operator override wins while the SDK constant is the
 *      documented contract fallback. Asserts the returned URI is
 *      `filecoin://piece/<cid>`, the SHA-256 content hash matches
 *      the plaintext, and the sidecar carries `driver=synapse`,
 *      `piece_cid`, `data_set_id` (positive decimal bigint),
 *      `copies[]`, `requested_copies`, `failed_attempts`,
 *      `complete`.
 *   3. The public projection (`projectFilecoinPublicMetadata`)
 *      drops `data_set_id` — that field is internal hint material,
 *      not for public consumption.
 *   4. `head(uri, hints)` accepts the `data_set_id` hint, returns a
 *      structurally valid `RawContentHeadResult`, and proves
 *      end-to-end the production-shaped hint plumbing reaches the
 *      Synapse SDK. (The "no-scan" short-circuit at the
 *      `SynapseFilecoinProviderClient` layer is pinned by
 *      `synapse-client-rw.test.ts` unit tests.)
 *   5. `get(uri)` retrieves the bytes and the SHA-256 matches
 *      the plaintext. SP-served HTTP retrieval typically works as
 *      soon as the upload completes (does NOT require PDP proof
 *      to land), so this step runs unconditionally under
 *      `FILECOIN_LIVE_TESTS=1` and proves the
 *      upload → retrieve → hash-verify lifecycle on every run.
 *   6. Optionally (gated by `FILECOIN_LIVE_TEST_MAX_WAIT_MS > 0`):
 *      poll `head` until `exists=true` and re-run `get`+hash to
 *      pin the proof-landed retrieval contract.
 *   7. `afterAll` deletes the uploaded piece with the hint and
 *      asserts the tombstone semantics returned. Cleanup surfaces
 *      failure (no silent catch); the provider boundary already
 *      sanitizes any thrown error.
 *
 * Safety:
 *   - Refuses to run against `mainnet`.
 *   - No private key, wallet address, allowance numeric, or vendor
 *     error message crosses any assertion or `console.*` call.
 *   - All sleeps are loop intervals bounded by an operator-set cap;
 *     no test logic uses fixed-sleep-then-assert.
 *
 * Recommended invocation (operator creates `.env.calibration` with
 * the new `RAW_STORAGE_FILECOIN_*` shape):
 *
 *   FILECOIN_LIVE_TESTS=1 FILECOIN_LIVE_TEST_MAX_WAIT_MS=900000 \
 *     dotenv -e .env.calibration -- npx vitest run \
 *     "src/storage/providers/filecoin/__tests__/live-calibration-smoke.test.ts" \
 *     --reporter=verbose --testTimeout=1200000
 */

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { SIZE_CONSTANTS } from '@filoz/synapse-sdk';
import {
  parseFilecoinProviderConfig,
  type FilecoinProviderConfig,
} from '../config.js';
import { buildSynapse } from '../synapse-construction.js';
import { SynapseFilecoinProviderClient } from '../synapse-client.js';
import { createFilecoinStorageBackend } from '../index.js';
import { checkFilecoinReadiness } from '../readiness.js';
import type {
  RawContentHints,
  RawContentStore,
  StoredRawContent,
} from '../../../raw-content-store.js';
import { projectFilecoinPublicMetadata } from '../../../filecoin-public-metadata.js';

const LIVE = process.env['FILECOIN_LIVE_TESTS'] === '1';
const MAX_PROOF_WAIT_MS = parseNonNegativeInt(
  process.env['FILECOIN_LIVE_TEST_MAX_WAIT_MS'],
  'FILECOIN_LIVE_TEST_MAX_WAIT_MS',
);
const LARGER_OBJECT_BYTES = parseNonNegativeInt(
  process.env['FILECOIN_LIVE_TEST_LARGER_BYTES'],
  'FILECOIN_LIVE_TEST_LARGER_BYTES',
);
const PROOF_POLL_INTERVAL_MS = 15_000;

interface BuiltProvider {
  readonly config: FilecoinProviderConfig;
  readonly store: RawContentStore;
  readonly client: SynapseFilecoinProviderClient;
}

async function buildProvider(): Promise<BuiltProvider> {
  const config = parseFilecoinProviderConfig(process.env);
  if (config.network !== 'calibration') {
    throw new Error(
      `live-calibration-smoke refuses to run against network='${config.network}'. ` +
        "Set RAW_STORAGE_FILECOIN_NETWORK=calibration before retrying.",
    );
  }
  const store = await createFilecoinStorageBackend(config);
  // Readiness uses the factory's internal primitives — production
  // does not yet surface readiness, so the `RawContentStore` adapter
  // does not expose it. Construction mirrors `index.ts:53-65`.
  const synapse = buildSynapse(config);
  const client = new SynapseFilecoinProviderClient(synapse, {
    copies: config.copies,
    providerIds: config.providerIds,
    dataSetMetadata: stringifyMetadata(config.dataSetMetadata),
    withCdn: config.withCdn,
    uploadTimeoutMs: config.uploadTimeoutMs,
    retrievalTimeoutMs: config.retrievalTimeoutMs,
    minUploadBytes: config.minUploadBytes,
    maxUploadBytes: config.maxUploadBytes,
  });
  return { config, store, client };
}

function stringifyMetadata(
  metadata: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)]));
}

function parseNonNegativeInt(raw: string | undefined, envVarName: string): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `${envVarName} must be a non-negative integer (got '${raw}').`,
    );
  }
  return Number.parseInt(raw, 10);
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Operator override (`RAW_STORAGE_FILECOIN_MIN_UPLOAD_BYTES`)
 * wins; otherwise fall back to the SDK-advertised constant
 * `SIZE_CONSTANTS.MIN_UPLOAD_SIZE`. The SDK constant is the
 * provider's documented contract minimum (not a magic literal);
 * the env override exists so an operator can raise the threshold
 * for their deployment without waiting for an SDK release.
 */
function resolveMinUploadBytes(provider: BuiltProvider): number {
  return provider.config.minUploadBytes ?? SIZE_CONSTANTS.MIN_UPLOAD_SIZE;
}

function extractSidecar(stored: StoredRawContent): Record<string, unknown> {
  const sibling = (stored.providerMetadata as Record<string, unknown>)['filecoin'];
  if (!sibling || typeof sibling !== 'object' || Array.isArray(sibling)) {
    throw new Error('upload sidecar missing the `filecoin` sibling');
  }
  return sibling as Record<string, unknown>;
}

function hintsFromSidecar(sidecar: Record<string, unknown>): RawContentHints {
  const dataSetId = sidecar['data_set_id'];
  if (typeof dataSetId !== 'string' || !/^[1-9][0-9]*$/.test(dataSetId)) {
    throw new Error('sidecar data_set_id is not a positive decimal bigint string');
  }
  // Pass the full `filecoin` sibling — `data_set_id` + `copies[]`
  // (with their per-copy `data_set_id` + `piece_id` scalars) —
  // so `FilecoinRawContentStore.delete` can extract both
  // `dataSetId` and `pieceId` and route through
  // `deletePiece({ piece: BigInt(pieceId) })` instead of the
  // CID-lookup path (which cannot resolve fresh pre-proof pieces).
  return { filecoin: sidecar };
}

/**
 * Poll `store.head(uri, hints)` until it reports `exists=true` OR
 * the elapsed time reaches `capMs`. Returns the elapsed ms on
 * success, `null` on cap-exhaustion. The exit condition is
 * observed state, not elapsed time, so this is not a
 * "fixed-sleep-then-assert" pattern — the inter-poll wait is just
 * how the test paces its observations of a real-world async
 * system (PDP proof landing on calibration chain).
 */
async function pollUntilProvenOrCap(
  store: RawContentStore,
  uri: string,
  hints: RawContentHints,
  capMs: number,
  intervalMs: number,
): Promise<number | null> {
  const start = Date.now();
  while (true) {
    const head = await store.head(uri, hints);
    if (head.exists) return Date.now() - start;
    const elapsed = Date.now() - start;
    if (elapsed + intervalMs >= capMs) return null;
    await sleep(intervalMs);
  }
}

/** A single live upload that needs deleting in `afterAll`. */
interface LiveUpload {
  readonly stored: StoredRawContent;
  readonly hints: RawContentHints;
}

describe.skipIf(!LIVE)('Filecoin live calibration smoke (production composition path)', () => {
  let provider: BuiltProvider;
  let minUploadBytes = 0;
  let payload: Buffer;
  let expectedHash: string;
  let stored: StoredRawContent | null = null;
  let hints: RawContentHints | null = null;
  // Larger-object regression piece (Phase 8). Tracked separately so
  // the existing `stored`/`hints` describe-scoped vars are not
  // disturbed by the opt-in tier.
  const additionalUploads: LiveUpload[] = [];

  beforeAll(async () => {
    provider = await buildProvider();
    minUploadBytes = resolveMinUploadBytes(provider);
    payload = Buffer.alloc(minUploadBytes, 0x61);
    expectedHash = sha256Hex(payload);
  });

  afterAll(async () => {
    // Delete WITH hints — the adapter extracts
    // `filecoin.data_set_id` + `filecoin.copies[].piece_id` and
    // calls `deletePiece({ piece: BigInt(pieceId) })` against the
    // hinted context, bypassing the SDK's CID→active-piece
    // lookup that fails for freshly-uploaded pre-proof pieces.
    // Production cleanup goes through the same hint path
    // (`storage/cleanup.ts` plumbs `raw_storage_metadata` into
    // `RawContentStore.delete`). Surface failures (no silent
    // catch); the provider boundary already sanitizes any throw
    // into a closed-set `FilecoinProviderError.errorCode`.
    const all: LiveUpload[] = [...additionalUploads];
    if (stored && hints) all.unshift({ stored, hints });
    for (const u of all) {
      const result = await provider.store.delete(u.stored.storageUri, u.hints);
      expect(result.semantics).toBe('tombstoned');
    }
  });

  it('readiness probe returns the documented check list', async () => {
    const result = await checkFilecoinReadiness(provider.client, 'calibration');
    expect(result.network).toBe('calibration');
    expect(result.provider).toBe('filecoin');
    expect(result.driver).toBe('synapse');
    expect(result.checks.length).toBeGreaterThan(0);
    // RPC reachability is the precondition: if `network_reachable`
    // failed, no other check can pass — fail with the precise code.
    const net = result.checks.find((c) => c.name === 'network_reachable');
    expect(net?.status, JSON.stringify(net)).toBe('passed');
    // Sanitization invariants on the serialized result.
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/0x[a-fA-F0-9]{40}\b/);
    expect(json).not.toMatch(/\b\d{15,}\b/);
  }, 90_000);

  it('upload at the configured/provider-advertised minimum size returns a filecoin://piece URI + populated sidecar', async () => {
    stored = await provider.store.put({ key: 'live-smoke', body: payload });
    expect(stored.storageProvider).toBe('filecoin');
    expect(stored.storageUri).toMatch(/^filecoin:\/\/piece\/.+$/);
    expect(stored.sizeBytes).toBe(minUploadBytes);
    expect(stored.contentHash).toBe(expectedHash);
    expect(stored.status).toBe('pending');

    const sidecar = extractSidecar(stored);
    expect(sidecar['driver']).toBe('synapse');
    expect(typeof sidecar['piece_cid']).toBe('string');
    expect(stored.storageUri.endsWith(sidecar['piece_cid'] as string)).toBe(true);
    expect(typeof sidecar['data_set_id']).toBe('string');
    expect(sidecar['data_set_id']).toMatch(/^[1-9][0-9]*$/);
    expect(Array.isArray(sidecar['copies'])).toBe(true);
    expect((sidecar['copies'] as unknown[]).length).toBeGreaterThan(0);
    expect(typeof sidecar['complete']).toBe('boolean');
    expect(typeof sidecar['requested_copies']).toBe('number');
    expect(typeof sidecar['failed_attempts']).toBe('number');

    hints = hintsFromSidecar(sidecar);
  }, 600_000);

  it('public projection drops data_set_id (privacy invariant)', () => {
    if (!stored) throw new Error('upload step did not run');
    const sidecar = extractSidecar(stored);
    const projected = projectFilecoinPublicMetadata(sidecar);
    expect(projected).not.toHaveProperty('data_set_id');
    expect(projected).not.toHaveProperty('driver');
    expect(typeof projected.piece_cid).toBe('string');
    expect(typeof projected.copy_count).toBe('number');
    expect(Array.isArray(projected.provider_ids)).toBe(true);
  });

  it('head with the data_set_id hint does not throw, returns a valid RawContentHeadResult, and carries no permanent-failure marker', async () => {
    if (!stored || !hints) throw new Error('upload step did not run');
    // Wrapping in `expect(...).resolves` proves the call returns
    // a resolved promise (no throw). The destructured result is
    // then shape-checked. PDP proof may not have landed yet, so
    // `exists` may legitimately be `false` — the assertion is
    // structural, not state.
    await expect(provider.store.head(stored.storageUri, hints)).resolves.toBeDefined();
    const head = await provider.store.head(stored.storageUri, hints);
    expect(typeof head.exists).toBe('boolean');
    // Per the documented `RawContentPermanentFailure` contract, the
    // `failure` field is set ONLY for terminal per-row failures
    // (onramp `failed`, malformed URI, etc.). A pending Filecoin
    // piece carries `exists=false` WITHOUT a failure marker so the
    // reconciler keeps the row pending. The smoke test pins this.
    expect((head as { failure?: unknown }).failure).toBeUndefined();
    if (head.exists) {
      expect(head.metadata).not.toBeNull();
      expect(head.metadata?.providerMetadata).toHaveProperty('piece_cid');
    } else {
      expect(head.metadata).toBeNull();
    }
  }, 90_000);

  it('get() retrieves the bytes and the SHA-256 matches plaintext (does not require PDP proof)', async () => {
    if (!stored) throw new Error('upload step did not run');
    // SP-served HTTP retrieval typically works as soon as the
    // bytes are accepted (no PDP proof required), which is what
    // makes this assertion stable for a bounded smoke test. Any
    // failure surfaces as a sanitized `FilecoinProviderError` via
    // the boundary — no vendor message, no secret. The test
    // timeout caps the wait deterministically.
    const got = await provider.store.get(stored.storageUri);
    expect(got.body.length).toBe(minUploadBytes);
    expect(sha256Hex(got.body)).toBe(expectedHash);
  }, 180_000);

  it.skipIf(LARGER_OBJECT_BYTES === 0)(
    'larger-object upload (FILECOIN_LIVE_TEST_LARGER_BYTES bytes) round-trips via get() + SHA-256 matches',
    async () => {
      // Phase 8 §larger object regression. The first piece runs at
      // the provider-advertised minimum (cheap, stable). This
      // SECOND piece exercises the same code paths at an
      // operator-chosen size to prove the upload→retrieve→hash
      // cycle is not sensitive to payload size below the
      // calibration USDFC allowance. Skipped by default
      // (`FILECOIN_LIVE_TEST_LARGER_BYTES=0`) so the standard
      // smoke does not pay for two pieces every run.
      //
      // Guard: the tier only proves anything if the payload is
      // STRICTLY larger than the minimum-size piece this same
      // smoke just uploaded. Otherwise a provider-side
      // min-size rejection would surface as an ambiguous failure
      // that looks identical to a real upload regression. Throw a
      // direct operator-facing error in that case instead.
      if (LARGER_OBJECT_BYTES <= minUploadBytes) {
        throw new Error(
          `FILECOIN_LIVE_TEST_LARGER_BYTES=${LARGER_OBJECT_BYTES} must be strictly greater than ` +
            `the resolved minUploadBytes=${minUploadBytes} (provider-advertised minimum upload ` +
            'size). Raise the value to exercise a meaningfully larger payload, or unset the env ' +
            'var to skip the larger-object tier.',
        );
      }
      const body = Buffer.alloc(LARGER_OBJECT_BYTES, 0x62);
      const hash = sha256Hex(body);
      const largerStored = await provider.store.put({ key: 'live-smoke-larger', body });
      expect(largerStored.storageUri).toMatch(/^filecoin:\/\/piece\/.+$/);
      expect(largerStored.sizeBytes).toBe(LARGER_OBJECT_BYTES);
      expect(largerStored.contentHash).toBe(hash);
      const sidecar = extractSidecar(largerStored);
      const largerHints = hintsFromSidecar(sidecar);
      additionalUploads.push({ stored: largerStored, hints: largerHints });
      const got = await provider.store.get(largerStored.storageUri);
      expect(got.body.length).toBe(LARGER_OBJECT_BYTES);
      expect(sha256Hex(got.body)).toBe(hash);
    },
    900_000,
  );

  it.skipIf(MAX_PROOF_WAIT_MS === 0)(
    'proof lands within FILECOIN_LIVE_TEST_MAX_WAIT_MS + get() retrieves bytes with matching hash',
    async () => {
      if (!stored || !hints) throw new Error('upload step did not run');
      const elapsed = await pollUntilProvenOrCap(
        provider.store,
        stored.storageUri,
        hints,
        MAX_PROOF_WAIT_MS,
        PROOF_POLL_INTERVAL_MS,
      );
      if (elapsed === null) {
        throw new Error(
          `PDP proof did not land within FILECOIN_LIVE_TEST_MAX_WAIT_MS=${MAX_PROOF_WAIT_MS}ms ` +
            `(poll interval ${PROOF_POLL_INTERVAL_MS}ms). Raise the cap or rerun later.`,
        );
      }
      const got = await provider.store.get(stored.storageUri);
      expect(got.body.length).toBe(minUploadBytes);
      expect(sha256Hex(got.body)).toBe(expectedHash);
    },
    MAX_PROOF_WAIT_MS + 60_000,
  );
});

describe.skipIf(LIVE)('Filecoin live calibration smoke — gated off by default', () => {
  it('skips everything unless FILECOIN_LIVE_TESTS=1', () => {
    expect(LIVE).toBe(false);
  });
});
