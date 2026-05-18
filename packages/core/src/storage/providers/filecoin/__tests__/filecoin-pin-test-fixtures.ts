/**
 * @file Shared test fixtures for the Phase 5 filecoin-pin driver
 * suite. Extracted so the per-test files stay focused on
 * assertions instead of repeating the same `executeUpload` mock
 * scaffold and the same `Synapse`/delegate stub shape.
 */

import type { Synapse } from '@filoz/synapse-sdk';
import type { SynapseFilecoinProviderClient } from '../synapse-client.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';

/** Shared dummy Synapse handle; no method is invoked under the unit-test paths. */
export const fakeSynapse = {} as unknown as Synapse;

/** Shared empty delegate stub; tests that don't exercise delegation pass this. */
export const fakeDelegate = {} as unknown as SynapseFilecoinProviderClient;

/**
 * Canonical-shape `executeUpload` result the tests share. Each
 * call site uses `vi.mocked(executeUpload).mockResolvedValueOnce(uploadResultFixture(...))`
 * and overrides only the fields the test cares about.
 */
export function uploadResultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pieceCid: REAL_PIECE_CID_A,
    size: 0,
    copies: [
      { providerId: 4n, dataSetId: 42n, pieceId: 7n, role: 'primary' },
      { providerId: 9n, dataSetId: 42n, pieceId: 7n, role: 'secondary' },
    ],
    failedAttempts: [],
    complete: true,
    requestedCopies: 2,
    network: 'calibration',
    ipniValidated: false,
    ...overrides,
  };
}
