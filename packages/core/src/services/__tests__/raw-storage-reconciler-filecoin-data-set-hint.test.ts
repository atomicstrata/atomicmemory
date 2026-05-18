/**
 * @file End-to-end proof that `runOnce` reads the
 * `raw_storage_metadata.filecoin.data_set_id` sidecar from the
 * claimed row and forwards it through the `RawContentStore.head`
 * boundary onto `FilecoinProviderClient.head` as `dataSetId`.
 *
 * Three rows seeded in a single tick:
 *   1. valid sidecar         → adapter receives dataSetId='42'
 *   2. absent sidecar        → adapter receives no dataSetId
 *   3. malformed sidecar     → adapter receives no dataSetId (drop + sanitize)
 *
 * The deep "findDataSets is not called" short-circuit lives at the
 * `SynapseFilecoinProviderClient` layer (covered by the existing
 * `synapse-client-rw.test.ts > head > uses the dataSetId hint...`
 * test). This file asserts the upper half of the plumbing — that
 * the reconciler reaches the provider client with the correct
 * input shape per sidecar state.
 *
 * Required: DATABASE_URL in .env.test with pgvector available.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../../db/pool.js';
import { runOnce } from '../raw-storage-reconciler.js';
import { FilecoinRawContentStore } from '../../storage/providers/filecoin/index.js';
import type {
  FilecoinHeadInput,
  FilecoinHeadResult,
} from '../../storage/providers/filecoin/provider-client.js';
import { clearDocumentTables, setupTestSchema } from '../../db/__tests__/test-fixtures.js';
import * as observability from '../filecoin-observability.js';
import {
  DEFAULT_DEPS,
  ReconcilerFilecoinTestClientBase,
  seedRow,
} from './raw-storage-reconciler-test-helpers.js';

class CapturingFilecoinClient extends ReconcilerFilecoinTestClientBase {
  readonly headInputs: FilecoinHeadInput[] = [];

  override async head(input: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    this.headInputs.push(input);
    // Unproven so the row stays pending; the assertions in this
    // file are about the INPUT plumbing, not the row outcome.
    return { exists: true, proven: false, providerMetadata: { piece_cid: 'baga-hint' } };
  }
}

beforeAll(async () => {
  await setupTestSchema(pool);
});

beforeEach(async () => {
  await clearDocumentTables(pool);
});

afterAll(async () => {
  await clearDocumentTables(pool);
  await pool.end();
});

describe('reconciler — Filecoin data_set_id hint plumbing through head()', () => {
  it('valid sidecar → FilecoinProviderClient.head receives dataSetId="42"', async () => {
    const client = new CapturingFilecoinClient();
    const store = new FilecoinRawContentStore(client);
    await seedRow({
      externalId: 'hint-valid',
      storageProvider: 'filecoin',
      storageUri: 'filecoin://piece/baga-hint',
      pendingSinceSecondsAgo: 60,
      rawStorageMetadata: { filecoin: { data_set_id: '42', piece_cid: 'baga-hint' } },
    });
    await runOnce({ ...DEFAULT_DEPS, store });
    expect(client.headInputs).toHaveLength(1);
    expect(client.headInputs[0]).toEqual({
      storageUri: 'filecoin://piece/baga-hint',
      dataSetId: '42',
    });
  });

  it('absent sidecar → FilecoinProviderClient.head receives NO dataSetId (scan path)', async () => {
    const client = new CapturingFilecoinClient();
    const store = new FilecoinRawContentStore(client);
    await seedRow({
      externalId: 'hint-absent',
      storageProvider: 'filecoin',
      storageUri: 'filecoin://piece/baga-hint-absent',
      pendingSinceSecondsAgo: 60,
      rawStorageMetadata: {},
    });
    await runOnce({ ...DEFAULT_DEPS, store });
    expect(client.headInputs).toHaveLength(1);
    expect(client.headInputs[0]?.storageUri).toBe('filecoin://piece/baga-hint-absent');
    expect(client.headInputs[0]).not.toHaveProperty('dataSetId');
  });

  it('malformed sidecar → no dataSetId forwarded; sanitized diagnostic emitted', async () => {
    const emitSpy = vi.spyOn(observability, 'emitFilecoinEvent');
    const client = new CapturingFilecoinClient();
    const store = new FilecoinRawContentStore(client);
    await seedRow({
      externalId: 'hint-malformed',
      storageProvider: 'filecoin',
      storageUri: 'filecoin://piece/baga-hint-mal',
      pendingSinceSecondsAgo: 60,
      rawStorageMetadata: { filecoin: { data_set_id: '0xdeadbeef' } },
    });
    await runOnce({ ...DEFAULT_DEPS, store });
    expect(client.headInputs[0]).not.toHaveProperty('dataSetId');
    const malformedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'filecoin.hint.malformed');
    expect(malformedEvents).toHaveLength(1);
    const detail = malformedEvents[0]?.[1] as { errorCode?: string };
    expect(detail.errorCode).toBe('data_set_id_not_positive_decimal_bigint');
    // Malformed value MUST NOT cross the diagnostic boundary.
    expect(JSON.stringify(malformedEvents[0]?.[1] ?? {})).not.toContain('deadbeef');
    emitSpy.mockRestore();
  });

  // The "non-Filecoin providers are unaffected" requirement is
  // proven at the adapter level in
  // `src/storage/__tests__/local-fs-store.test.ts > head + delete
  // ignore the optional RawContentHints arg`. The reconciler's
  // `assertReconciliableProvider` gate (see
  // `db/raw-storage-reconciliation-repository.ts`) rejects non-
  // Filecoin providers from `runOnce` entirely, so the integration
  // assertion there is not reachable.
});
