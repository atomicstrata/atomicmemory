/**
 * @file Phase 7 — delete-semantics tests at the
 * `FilecoinRawContentStore` adapter level.
 *
 * Pins the four scenarios the harvest plan §Phase 7 calls out
 * deterministically (no live Synapse SDK):
 *
 *   1. **Delete success with piece-id hint** — the inner
 *      provider client returns
 *      `{ deleted: true, semantics: 'tombstone', txHash: '0x…' }`
 *      after `deletePiece({ piece: BigInt(pieceId) })`. The
 *      adapter maps `semantics` → `'tombstoned'` (the closed
 *      generic enum) AND threads `txHash` through as the
 *      internal billing/cost-impact metadata.
 *
 *   2. **Delete in-flight / already-missing** — the inner
 *      client returns `{ deleted: false, semantics: 'tombstone' }`
 *      with no `txHash` (no chain action was needed). The
 *      adapter maps to `{ deleted: false, semantics: 'tombstoned' }`
 *      and OMITS `txHash`.
 *
 *   3. **Provider-retained tombstone (no piece-id hint
 *      available)** — the inner client reports `'tombstone'`
 *      either because the CID-lookup fallback was taken or
 *      because the piece couldn't be removed from the SP
 *      ledger immediately. The adapter still surfaces
 *      `'tombstoned'` accurately — no stronger semantic.
 *
 *   4. **Failed cleanup** — the inner client throws a
 *      sanitized `FilecoinProviderError`. The adapter
 *      propagates without leaking the raw vendor message.
 *
 * The harvest plan invariant "no driver reports stronger delete
 * semantics than it can actually provide" is enforced by the
 * adapter's hardcoded `'tombstoned'` — every Filecoin delete
 * surfaces the conservative tombstone semantic regardless of
 * whether the on-chain tx landed.
 */

import { describe, expect, it, vi } from 'vitest';
import { FilecoinRawContentStore } from '../backend.js';
import { FilecoinProviderError } from '../errors.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';
import type {
  FilecoinDeleteInput,
  FilecoinDeleteResult,
  FilecoinProviderClient,
} from '../provider-client.js';

const PIECE_URI = `filecoin://piece/${REAL_PIECE_CID_A}`;

interface FakeDeleteBehaviour {
  readonly deleted: boolean;
  readonly semantics: 'tombstone' | 'unpin' | 'delete';
  readonly txHash?: string;
  readonly throws?: FilecoinProviderError;
}

function fakeClient(behaviour: FakeDeleteBehaviour): {
  client: FilecoinProviderClient;
  deleteSpy: ReturnType<typeof vi.fn>;
} {
  const deleteSpy = vi.fn(async (input: FilecoinDeleteInput): Promise<FilecoinDeleteResult> => {
    void input;
    if (behaviour.throws !== undefined) throw behaviour.throws;
    return {
      deleted: behaviour.deleted,
      semantics: behaviour.semantics,
      ...(behaviour.txHash !== undefined ? { txHash: behaviour.txHash } : {}),
    };
  });
  const client = {
    provider: 'filecoin',
    driver: 'synapse',
    put: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    delete: deleteSpy,
    verify: vi.fn(),
    checkReadiness: vi.fn(),
    getServiceMinUploadBytes: vi.fn(),
  } as unknown as FilecoinProviderClient;
  return { client, deleteSpy };
}

describe('FilecoinRawContentStore.delete — Phase 7 semantics mapping', () => {
  it('delete success: surfaces tombstoned + threads txHash through as internal billing/cost-impact metadata', async () => {
    const { client, deleteSpy } = fakeClient({
      deleted: true,
      semantics: 'tombstone',
      txHash: '0xdeadbeefcafef00d',
    });
    const store = new FilecoinRawContentStore(client);
    const out = await store.delete(PIECE_URI, {
      filecoin: { data_set_id: '42', copies: [{ data_set_id: '42', piece_id: '7' }] },
    });
    expect(out).toEqual({
      deleted: true,
      semantics: 'tombstoned',
      txHash: '0xdeadbeefcafef00d',
    });
    // The hint reader plumbed both fields through to the inner
    // delete — piece-id-hinted delete is the cross-driver
    // invariant from §Phase 7.
    expect(deleteSpy).toHaveBeenCalledWith({
      storageUri: PIECE_URI,
      dataSetId: '42',
      pieceId: '7',
    });
  });

  it('delete in-flight / already-missing: deleted=false, semantics=tombstoned, NO txHash key', async () => {
    const { client } = fakeClient({ deleted: false, semantics: 'tombstone' });
    const store = new FilecoinRawContentStore(client);
    const out = await store.delete(PIECE_URI);
    expect(out.deleted).toBe(false);
    expect(out.semantics).toBe('tombstoned');
    // The adapter conditionally spreads `txHash` only when
    // present — confirms an already-missing case does not
    // fabricate a fake hash key.
    expect('txHash' in out).toBe(false);
  });

  it('provider-retained tombstone (CID-lookup fallback path): adapter does not promote to a stronger semantic', async () => {
    // Filecoin-pin's piece-id-hint omission case (Phase 5
    // finding) ends up here: no `piece_id` in the sidecar →
    // adapter's hint reader returns `pieceId: null` → inner
    // client uses CID lookup → may return
    // `{ deleted: false, semantics: 'tombstone' }` if the
    // piece couldn't be located. The adapter MUST NOT report
    // `'deleted'` — operators rely on `'tombstoned'` to mean
    // "we stopped managing the bytes, but the network may
    // still serve."
    const { client, deleteSpy } = fakeClient({ deleted: false, semantics: 'tombstone' });
    const store = new FilecoinRawContentStore(client);
    const out = await store.delete(PIECE_URI, {
      // Note: no `copies[].piece_id` — forces CID-lookup fallback.
      filecoin: { data_set_id: '42' },
    });
    expect(out.semantics).toBe('tombstoned');
    expect(deleteSpy).toHaveBeenCalledWith({
      storageUri: PIECE_URI,
      dataSetId: '42',
    });
    expect(deleteSpy.mock.calls[0]![0]).not.toHaveProperty('pieceId');
  });

  it('failed cleanup: propagates the inner sanitized FilecoinProviderError unchanged (vendor stack stays inside)', async () => {
    // The inner client is responsible for sanitisation
    // (`wrapSynapseDeleteError` in `synapse-error-mapping.ts`).
    // The adapter just propagates the typed error so the route
    // layer / cleanup loop sees the closed `errorCode`. The
    // assertion below pins identity (same instance crosses the
    // boundary unmodified) — proof that the adapter does not
    // re-wrap with a different message that could accidentally
    // re-introduce vendor strings.
    const sanitized = new FilecoinProviderError(
      'filecoin_delete_failed',
      'Synapse deletePiece failed; vendor error suppressed at the provider boundary.',
    );
    const { client } = fakeClient({ deleted: false, semantics: 'tombstone', throws: sanitized });
    const store = new FilecoinRawContentStore(client);
    let caught: unknown;
    try {
      await store.delete(PIECE_URI);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(sanitized);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_delete_failed');
  });
});

describe('FilecoinRawContentStore.delete — piece-id-hinted-delete invariant across drivers', () => {
  it('synapse driver result + filecoin-pin delegate result map identically through the adapter', async () => {
    // Both drivers' `FilecoinDeleteResult` shape is identical;
    // the harvest plan invariant says they must surface the
    // same adapter-level outcome.
    const synapseResult: FilecoinDeleteResult = {
      deleted: true, semantics: 'tombstone', txHash: '0xfromSynapse',
    };
    const filecoinPinResult: FilecoinDeleteResult = {
      deleted: true, semantics: 'tombstone', txHash: '0xfromPin',
    };
    const synapse = fakeClient({ ...synapseResult });
    const pin = fakeClient({ ...filecoinPinResult });
    const synapseOut = await new FilecoinRawContentStore(synapse.client).delete(PIECE_URI);
    const pinOut = await new FilecoinRawContentStore(pin.client).delete(PIECE_URI);
    // Same closed shape, distinct txHashes. The adapter is the
    // single mapping point — both drivers go through it.
    expect(synapseOut.semantics).toBe('tombstoned');
    expect(pinOut.semantics).toBe('tombstoned');
    expect(synapseOut.txHash).toBe('0xfromSynapse');
    expect(pinOut.txHash).toBe('0xfromPin');
  });
});
