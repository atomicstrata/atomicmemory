/**
 * @file Unit tests for `SynapseFilecoinProviderClient.delete`.
 *
 * Split out of `synapse-client-rw.test.ts` to keep both files
 * under the workspace 400-LOC cap. Shared fakes live in
 * `synapse-client-rw-fixtures.ts`.
 *
 * The delete suite specifically exercises:
 *   - CID-based delete (legacy path)
 *   - `pieceId`-hinted delete via `BigInt(pieceId)` — the path
 *     that bypasses Synapse's PDP active-piece lookup and lets
 *     a freshly-uploaded pre-proof piece be tombstoned (this is
 *     the root-cause fix for the live calibration failure mode)
 *   - malformed `pieceId` → sanitized `filecoin_invalid_piece_id`
 *   - idempotent delete when no data set holds the piece
 *   - vendor-error sanitization on `deletePiece` rejection
 */

import { describe, expect, it } from 'vitest';
import { SynapseFilecoinProviderClient } from '../synapse-client.js';
import { FilecoinProviderError } from '../errors.js';
import {
  buildFakeContext,
  buildFakeSynapse,
  fakePieceStatus,
  PIECE_CID,
  PIECE_URI,
} from './synapse-client-rw-fixtures.js';

describe('SynapseFilecoinProviderClient.delete', () => {
  it('calls context.deletePiece and surfaces the tx hash', async () => {
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus(),
      deleteHash: '0xabcdef1234',
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.delete({ storageUri: PIECE_URI, dataSetId: '42' });
    expect(out).toEqual({ deleted: true, semantics: 'tombstone', txHash: '0xabcdef1234' });
    expect(ctx.deletePiece).toHaveBeenCalledWith({ piece: PIECE_CID });
  });

  it('with pieceId hint: deletePiece receives BigInt(pieceId), bypassing CID lookup', async () => {
    // The CID-based lookup fails for freshly-uploaded pre-proof
    // pieces (the live-calibration failure mode). Passing the
    // explicit `pieceId` from the upload sidecar lets the SDK
    // delete by id directly, which the SP can resolve immediately.
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus(),
      deleteHash: '0xfeedface',
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.delete({ storageUri: PIECE_URI, dataSetId: '42', pieceId: '7' });
    expect(out.deleted).toBe(true);
    expect(ctx.deletePiece).toHaveBeenCalledWith({ piece: 7n });
    expect(ctx.deletePiece).not.toHaveBeenCalledWith({ piece: PIECE_CID });
  });

  it('with malformed pieceId hint: rejects with sanitized filecoin_invalid_piece_id (no value leak)', async () => {
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus(),
      deleteHash: '0x00',
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.delete({ storageUri: PIECE_URI, dataSetId: '42', pieceId: '0xff' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_invalid_piece_id');
    expect((caught as Error).message).not.toContain('0xff');
  });

  it('reports deleted=false when no data set holds the piece (idempotent tombstone)', async () => {
    const { synapse } = buildFakeSynapse({ dataSets: [] });
    const client = new SynapseFilecoinProviderClient(synapse);
    const out = await client.delete({ storageUri: PIECE_URI });
    expect(out).toEqual({ deleted: false, semantics: 'tombstone' });
  });

  it('sanitizes vendor errors raised by deletePiece', async () => {
    const ctx = buildFakeContext({
      dataSetId: 42n,
      pieceStatus: fakePieceStatus(),
      deleteError: new Error('signer balance too low: 0x1234567890abcdef'),
    });
    const { synapse } = buildFakeSynapse({ contexts: new Map([[42n, ctx]]) });
    const client = new SynapseFilecoinProviderClient(synapse);
    let caught: unknown;
    try {
      await client.delete({ storageUri: PIECE_URI, dataSetId: '42' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FilecoinProviderError);
    expect((caught as FilecoinProviderError).errorCode).toBe('filecoin_delete_failed');
    expect((caught as Error).message).not.toContain('0x1234567890abcdef');
  });
});
