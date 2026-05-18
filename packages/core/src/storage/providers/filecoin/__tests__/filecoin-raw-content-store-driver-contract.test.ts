/**
 * @file Driver-agnostic contract tests for `FilecoinRawContentStore`.
 *
 * Imports ONLY from `provider-client-fixtures.ts` — a vendor-free
 * `FilecoinProviderClient` fixture. The fixture's import graph
 * never touches `@filoz/synapse-sdk` or `viem`, so these tests
 * exercise the adapter purely through the boundary it claims to
 * sit above. Any future driver that implements
 * `FilecoinProviderClient` must satisfy the same assertions.
 *
 * Four describes:
 *
 *   1. `FilecoinRawContentStore is driver-agnostic on
 *      put/get/head/delete` — same canned provider-client
 *      responses, run once with a `driver: 'synapse'` fake and
 *      once with a `driver: 'filecoin_pin'` fake. Generic adapter
 *      output shape is identical EXCEPT `sidecar.driver`, which
 *      intentionally reflects the boundary's driver literal
 *      (asserted in describe #2). Note: the provider-client fake
 *      returns `semantics: 'tombstone'` (provider-level enum);
 *      the adapter MAPS this to `semantics: 'tombstoned'`
 *      (generic). The test builds the fake with the provider-
 *      level literal and asserts the generic literal on the
 *      adapter output.
 *
 *   2. `sidecar.driver reflects the boundary's driver literal,
 *      not a hardcoded one` — `'filecoin_pin'`-flavored fake's
 *      put produces `stored.providerMetadata.filecoin.driver ===
 *      'filecoin_pin'`; Synapse-flavored fake produces
 *      `'synapse'`. Pins the harvest-plan invariant.
 *
 *   3. `checkFilecoinReadiness reflects client.driver` — the
 *      readiness aggregate's `driver` field reads `client.driver`
 *      instead of hardcoding `'synapse'`.
 *
 *   4. `closed-union exhaustiveness compile-time guard` — a
 *      `satisfies never` type-level assertion on an exhaustive
 *      switch over `FilecoinDriverName`. tsc rejects any silent
 *      widening to `string`.
 */

import { describe, expect, it } from 'vitest';
import { FilecoinRawContentStore } from '../backend.js';
import { checkFilecoinReadiness } from '../readiness.js';
import type {
  FilecoinDriverName,
  FilecoinHeadResult,
  FilecoinPutResult,
} from '../provider-client.js';
import type { StoredRawContent } from '../../../raw-content-store.js';
import { REAL_PIECE_CID_B } from '../../../__tests__/filecoin-cid-fixtures.js';
import { buildFakeFilecoinProviderClient } from './provider-client-fixtures.js';

// Phase 3 hardened: PieceCID must round-trip through the real
// Synapse SDK parser. `REAL_PIECE_CID_B` is a distinct real
// PieceCID from `synapse-client-rw-fixtures.ts:PIECE_CID` so a
// regression confusing the two values would be immediately
// visible. A shape-only synthetic would falsely pass the
// regex-based structural gate while failing the SDK parser; we
// keep the suite honest by using the real value here.
const PIECE_CID = REAL_PIECE_CID_B;
const PIECE_URI = `filecoin://piece/${PIECE_CID}`;
const PUT_BODY = Buffer.from('hello world');

function cannedPutResult(): FilecoinPutResult {
  return {
    pieceCid: PIECE_CID,
    storageUri: PIECE_URI,
    sizeBytes: 11,
    copies: [
      { providerId: '1', dataSetId: '42', pieceId: '7', role: 'primary' },
    ],
    failedAttempts: [],
    complete: true,
    requestedCopies: 1,
  };
}

function cannedHeadResult(): FilecoinHeadResult {
  return {
    exists: true,
    proven: true,
    providerMetadata: { piece_cid: PIECE_CID },
  };
}

// Shared helper for both "driver-agnostic put" and "sidecar.driver
// reflects boundary" scenarios — same fixture wiring, same put.
async function putThroughDriver(driver: FilecoinDriverName): Promise<StoredRawContent> {
  const { client } = buildFakeFilecoinProviderClient(
    { put: cannedPutResult() },
    { driver },
  );
  const store = new FilecoinRawContentStore(client);
  return store.put({ key: 'k', body: PUT_BODY });
}

describe('FilecoinRawContentStore is driver-agnostic on put/get/head/delete', () => {
  // Each scenario runs the SAME canned provider-client responses
  // against the SAME adapter code, varying only the boundary's
  // driver literal. Generic-shape outputs must be identical.
  const drivers: ReadonlyArray<FilecoinDriverName> = ['synapse', 'filecoin_pin'];

  it.each(drivers)('put: returns identical generic shape (driver=%s)', async (driver) => {
    const stored = await putThroughDriver(driver);
    expect(stored.storageProvider).toBe('filecoin');
    expect(stored.storageUri).toBe(PIECE_URI);
    expect(stored.sizeBytes).toBe(11);
    expect(stored.status).toBe('pending');
  });

  it.each(drivers)('head: returns shape-valid result (driver=%s)', async (driver) => {
    const { client } = buildFakeFilecoinProviderClient(
      { head: cannedHeadResult() },
      { driver },
    );
    const store = new FilecoinRawContentStore(client);
    const head = await store.head(PIECE_URI);
    expect(head.exists).toBe(true);
    expect(head.metadata?.providerMetadata).toEqual({ piece_cid: PIECE_CID });
  });

  it.each(drivers)('get: forwards body + builds RawContentMetadata (driver=%s)', async (driver) => {
    const { client } = buildFakeFilecoinProviderClient(
      { get: { body: Buffer.from('payload'), providerMetadata: { piece_cid: PIECE_CID } } },
      { driver },
    );
    const store = new FilecoinRawContentStore(client);
    const out = await store.get(PIECE_URI);
    expect(out.body.toString('utf8')).toBe('payload');
    expect(out.metadata.contentLength).toBe('payload'.length);
  });

  it.each(drivers)(
    'delete: provider tombstone → adapter tombstoned (driver=%s)',
    async (driver) => {
      // Fake's `delete` returns the provider-level enum
      // (`'tombstone' | 'unpin' | 'delete'`). The adapter maps it
      // to the generic `'tombstoned'` literal. This asserts the
      // mapping, not the provider-level shape.
      const { client } = buildFakeFilecoinProviderClient(
        { delete: { deleted: true, semantics: 'tombstone' } },
        { driver },
      );
      const store = new FilecoinRawContentStore(client);
      const out = await store.delete(PIECE_URI);
      expect(out.deleted).toBe(true);
      expect(out.semantics).toBe('tombstoned');
    },
  );
});

describe("sidecar.driver reflects the boundary's driver literal, not a hardcoded one", () => {
  it.each([
    ['synapse', 'synapse'],
    ['filecoin_pin', 'filecoin_pin'],
  ] as ReadonlyArray<readonly [FilecoinDriverName, string]>)(
    'driver=%s → sidecar.driver=%s',
    async (driver, expectedSidecarDriver) => {
      const stored = await putThroughDriver(driver);
      const sidecar = (stored.providerMetadata as { filecoin: { driver: string } }).filecoin;
      expect(sidecar.driver).toBe(expectedSidecarDriver);
    },
  );
});

describe('checkFilecoinReadiness reflects client.driver', () => {
  it.each(['synapse', 'filecoin_pin'] as ReadonlyArray<FilecoinDriverName>)(
    'driver=%s → result.driver matches the boundary',
    async (driver) => {
      const { client } = buildFakeFilecoinProviderClient(
        { checkReadiness: [{ name: 'network_reachable', status: 'passed' }] },
        { driver },
      );
      const result = await checkFilecoinReadiness(client, 'calibration');
      expect(result.driver).toBe(driver);
      expect(result.provider).toBe('filecoin');
      expect(result.network).toBe('calibration');
    },
  );
});

describe('closed-union exhaustiveness compile-time guard', () => {
  it('every FilecoinDriverName branch is handled; default arm is `never`', () => {
    // Compile-time assertion: tsc rejects any silent widening of
    // `FilecoinDriverName` to `string`. If a new driver literal
    // is added to the union, this switch becomes non-exhaustive
    // and the default-arm `satisfies never` fails the build.
    function exhaustiveBranchCheck(driver: FilecoinDriverName): string {
      switch (driver) {
        case 'synapse':
          return 'synapse';
        case 'filecoin_pin':
          return 'filecoin_pin';
        default:
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const exhaustive = driver satisfies never;
          throw new Error(`unhandled driver: ${exhaustive as never}`);
      }
    }
    expect(exhaustiveBranchCheck('synapse')).toBe('synapse');
    expect(exhaustiveBranchCheck('filecoin_pin')).toBe('filecoin_pin');
  });
});
