/**
 * @file Closed-key + serialization leak invariants for
 * `cleanupManagedBlobs` success/failure result DTOs.
 *
 * `ManagedBlobRef.rawStorageMetadata` (the Filecoin sidecar JSONB)
 * is INPUT-ONLY: it carries `data_set_id`, `copies[].piece_id`,
 * planted operator secrets (`private_key`, `wallet_address`,
 * `signed_request`), and the optional Phase 4 `ipfs_cid` hint.
 * None of that may surface on result entries, the
 * `ManagedBlobCleanupResult` aggregate, or its JSON
 * serialization — only the three approved public fields
 * (`rawDocumentId`, `storageProvider`, `storageUri`) plus the
 * adapter's own success-vs-failure scalars (`deleted`,
 * `semantics`, `message`).
 *
 * Closed key set:
 *   - success: `rawDocumentId | storageProvider | storageUri | deleted | semantics`
 *   - failure: `rawDocumentId | storageProvider | storageUri | message`
 * Top-level aggregate: `attempted | deleted | alreadyMissing | successes | failures`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupManagedBlobs, type ManagedBlobRef } from '../cleanup.js';
import { singleStoreRegistry } from '../store-registry.js';
import * as filecoinObservability from '../../services/filecoin-observability.js';
import type {
  PutRawContentInput,
  RawContentDeleteResult,
  RawContentGetResult,
  RawContentHeadResult,
  RawContentHints,
  RawContentStore,
  RawContentStoreCapabilities,
  StoredRawContent,
} from '../raw-content-store.js';

const FILECOIN_CAPS: RawContentStoreCapabilities = {
  addressing: 'content',
  retrievalConsistency: 'eventual',
  deleteSemantics: 'tombstone',
  supportsHead: true,
  supportsGet: true,
};

type FakeBehaviour =
  | 'ok'                         // deleted=true, semantics=tombstoned, no txHash
  | 'ok-with-txhash'              // deleted=true, semantics=tombstoned, billing-cost-impact txHash
  | 'in-flight'                   // deleted=false (already-missing / pre-confirmation)
  | 'throw';                      // adapter raises

/** The planted on-chain hash a real Synapse delete would surface. */
const PLANTED_TX_HASH = '0xPLANTED_CHAIN_TX_HASH_DO_NOT_LEAK';

class FakeFilecoinStore implements RawContentStore {
  readonly provider = 'filecoin';
  readonly capabilities = FILECOIN_CAPS;
  constructor(private readonly behavior: FakeBehaviour) {}
  async put(_: PutRawContentInput): Promise<StoredRawContent> { throw new Error('unused'); }
  async get(): Promise<RawContentGetResult> { throw new Error('unused'); }
  async head(): Promise<RawContentHeadResult> { throw new Error('unused'); }
  async delete(_uri: string, _hints?: RawContentHints): Promise<RawContentDeleteResult> {
    if (this.behavior === 'throw') {
      throw new Error('PLANTED-ADAPTER-ERROR');
    }
    if (this.behavior === 'in-flight') {
      return { deleted: false, semantics: 'tombstoned' };
    }
    if (this.behavior === 'ok-with-txhash') {
      return { deleted: true, semantics: 'tombstoned', txHash: PLANTED_TX_HASH };
    }
    return { deleted: true, semantics: 'tombstoned' };
  }
}

const PLANTED_SIDECAR: Record<string, unknown> = {
  codec: { name: 'aes_gcm', version: 1, nonce: 'PLANTED-NONCE', tag: 'PLANTED-TAG' },
  filecoin: {
    driver: 'synapse',
    piece_cid: 'baga-planted',
    ipfs_cid: 'bafy-planted-leak',
    data_set_id: '42',
    copies: [
      { provider_id: 'f01', data_set_id: '42', piece_id: '7', status: 'accepted' },
    ],
    private_key: 'PLANTED-KEY',
    wallet_address: 'PLANTED-WALLET',
    signed_request: 'PLANTED-SIGNED',
  },
};

const SUCCESS_KEYS = ['rawDocumentId', 'storageProvider', 'storageUri', 'deleted', 'semantics'];
const FAILURE_KEYS = ['rawDocumentId', 'storageProvider', 'storageUri', 'message'];

function makeRef(): ManagedBlobRef {
  return {
    rawDocumentId: 'doc-1',
    storageProvider: 'filecoin',
    storageUri: 'filecoin://piece/baga-canonical',
    rawStorageMetadata: PLANTED_SIDECAR,
  };
}

describe('cleanupManagedBlobs — closed-key + leak invariants', () => {
  it('success entries carry only the approved keys', async () => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('ok'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(result.successes).toHaveLength(1);
    expect(Object.keys(result.successes[0]!).sort()).toEqual([...SUCCESS_KEYS].sort());
  });

  it('failure entries carry only the approved keys', async () => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('throw'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(result.failures).toHaveLength(1);
    expect(Object.keys(result.failures[0]!).sort()).toEqual([...FAILURE_KEYS].sort());
  });

  it.each([
    ['planted private_key', 'PLANTED-KEY'],
    ['planted wallet_address', 'PLANTED-WALLET'],
    ['planted signed_request', 'PLANTED-SIGNED'],
    ['planted AES-GCM nonce', 'PLANTED-NONCE'],
    ['planted ipfs_cid (Phase 4 hint, not for cleanup output)', 'bafy-planted-leak'],
    ['internal piece_id scalar from copies[]', 'baga-planted'],
    ['internal data_set_id from sidecar', '42'],
    ['the `ipfs_cid` JSONB key itself', 'ipfs_cid'],
    ['the `piece_id` JSONB key itself', 'piece_id'],
    ['the `data_set_id` JSONB key itself', 'data_set_id'],
  ])('serialized success-path result never contains %s', async (_label, needle) => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('ok'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(JSON.stringify(result)).not.toContain(needle);
  });

  it.each([
    ['planted private_key', 'PLANTED-KEY'],
    ['planted signed_request', 'PLANTED-SIGNED'],
    ['internal piece_id scalar from copies[]', 'baga-planted'],
    ['the `ipfs_cid` JSONB key itself', 'ipfs_cid'],
    ['the `data_set_id` JSONB key itself', 'data_set_id'],
  ])('serialized failure-path result never contains %s', async (_label, needle) => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('throw'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(JSON.stringify(result)).not.toContain(needle);
  });
});

describe('cleanupManagedBlobs — Phase 7 delete-result DTO + txHash leak invariants', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(filecoinObservability, 'emitFilecoinEvent').mockImplementation(() => undefined);
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('SUCCESS DTO still has the closed key set even when the adapter returns a txHash', async () => {
    // `RawContentDeleteResult.txHash` is INTERNAL — it MUST NOT
    // appear in the cleanup success entry that surfaces to
    // route handlers / 500 envelopes / observability consumers.
    const registry = singleStoreRegistry(new FakeFilecoinStore('ok-with-txhash'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(result.successes).toHaveLength(1);
    expect(Object.keys(result.successes[0]!).sort()).toEqual([...SUCCESS_KEYS].sort());
    // No `txHash` key crept in.
    expect('txHash' in result.successes[0]!).toBe(false);
    expect('deleteTxHash' in result.successes[0]!).toBe(false);
  });

  it('serialized result NEVER contains the planted on-chain tx hash (closed-key proof)', async () => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('ok-with-txhash'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(JSON.stringify(result)).not.toContain(PLANTED_TX_HASH);
    expect(JSON.stringify(result)).not.toContain('txHash');
  });

  it('emits filecoin.delete.tombstoned with deleteTxHash on the internal observability channel only', async () => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('ok-with-txhash'));
    await cleanupManagedBlobs(registry, [makeRef()]);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = emitSpy.mock.calls[0]!;
    expect(eventName).toBe('filecoin.delete.tombstoned');
    expect(payload).toMatchObject({
      provider: 'filecoin',
      deleteTxHash: PLANTED_TX_HASH,
      statusAfter: 'blob_tombstoned',
    });
  });

  it('end-to-end through the real emit path: stdout line carries deleteTxHash + drops planted sidecar fields', async () => {
    // The `vi.spyOn(emitFilecoinEvent)` test above intercepts the
    // call BEFORE `buildFilecoinEvent`/`projectPayload` run —
    // which is what hid a runtime-allowlist regression the
    // first time around (`deleteTxHash` typed but not in
    // ALLOWED_PAYLOAD_KEYS → silently stripped at emit).
    //
    // This test exercises the FULL path: restore the real
    // `emitFilecoinEvent`, hook `console.log` instead, run the
    // cleanup, and inspect the actual `[FILECOIN]` line that
    // hit stdout. The runtime allowlist is what determines
    // what makes it through.
    emitSpy.mockRestore();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const registry = singleStoreRegistry(new FakeFilecoinStore('ok-with-txhash'));
      await cleanupManagedBlobs(registry, [makeRef()]);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0]![0] as string;
      expect(line.startsWith('[FILECOIN] ')).toBe(true);
      const parsed = JSON.parse(line.slice('[FILECOIN] '.length));
      expect(parsed.event).toBe('filecoin.delete.tombstoned');
      expect(parsed.detail.deleteTxHash).toBe(PLANTED_TX_HASH);
      expect(parsed.detail.provider).toBe('filecoin');
      expect(parsed.detail.statusAfter).toBe('blob_tombstoned');
      // Raw sidecar / credential fields still get redacted —
      // the new allowlist entry doesn't open a hole for them.
      // (The cleanup loop only forwards deleteTxHash + provider
      // + statusAfter, but pin it anyway in case a future
      // refactor widens the payload it constructs.)
      expect(line).not.toContain('PLANTED-KEY');
      expect(line).not.toContain('bafy-planted-leak');
      expect(line).not.toContain('"piece_id"');
      expect(line).not.toContain('"data_set_id"');
      expect(line).not.toContain('"ipfs_cid"');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('IN-FLIGHT delete (deleted=false) reports tombstoned WITHOUT a txHash event', async () => {
    // Already-missing / pre-confirmation case — the inner client
    // returned no `txHash` because no on-chain tx was issued.
    // The success DTO carries `deleted: false`; no observability
    // emit fires.
    const registry = singleStoreRegistry(new FakeFilecoinStore('in-flight'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(result.successes[0]!.deleted).toBe(false);
    expect(result.successes[0]!.semantics).toBe('tombstoned');
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('FAILURE path emits no txHash event (no on-chain action happened)', async () => {
    const registry = singleStoreRegistry(new FakeFilecoinStore('throw'));
    const result = await cleanupManagedBlobs(registry, [makeRef()]);
    expect(result.failures).toHaveLength(1);
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
