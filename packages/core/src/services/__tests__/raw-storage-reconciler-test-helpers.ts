/**
 * Shared fixtures for the raw-storage reconciler test split. Lives in
 * `services/__tests__/` (not in the global `db/__tests__/test-fixtures.ts`)
 * because these helpers are reconciler-scoped — seeding `raw_documents`
 * rows with explicit claim / next_check_at / pending_since timestamps
 * isn't useful outside the reconciler suite.
 */

import { pool } from '../../db/pool.js';
import {
  registerRawDocument,
  upsertRawSource,
} from '../../db/raw-document-repository.js';
import type {
  RawContentHeadResult,
  RawContentStore,
} from '../../storage/raw-content-store.js';
import { NoopRawContentCodec } from '../../storage/codecs/noop-codec.js';
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
} from '../../storage/providers/filecoin/provider-client.js';
import type { ReconcilerDeps } from '../raw-storage-reconciler.js';

export const USER = 'phase6-reconciler-user';

export interface FakeStoreOpts {
  head: (uri: string) => Promise<RawContentHeadResult>;
  provider?: string;
}

export function makeStore(opts: FakeStoreOpts): RawContentStore {
  return {
    provider: opts.provider ?? 'filecoin',
    capabilities: {
      addressing: 'content',
      retrievalConsistency: 'eventual',
      deleteSemantics: 'tombstone',
      supportsHead: true,
      supportsGet: true,
    },
    put: async () => { throw new Error('not used'); },
    get: async () => { throw new Error('not used'); },
    head: opts.head,
    delete: async () => ({ deleted: false, semantics: 'tombstoned' }),
  };
}

/**
 * Canonical "head returns retrievable" probe — used by every test
 * that wants the row promoted to `blob_available`.
 */
export const headRetrievable = async (): Promise<RawContentHeadResult> => ({
  exists: true,
  metadata: { contentLength: 0, contentType: null, contentHash: null, providerMetadata: {} },
});

/** Canonical "head returns not-yet-retrievable" probe (transient pending). */
export const headPending = async (): Promise<RawContentHeadResult> => ({
  exists: false, metadata: null,
});

export interface SeedOptions {
  externalId: string;
  rawStorageStatus?: 'blob_pending' | 'blob_uploading' | 'blob_stored' | 'blob_available';
  storageUri?: string | null;
  storageProvider?: string | null;
  claimId?: string | null;
  claimedAtSecondsAgo?: number;
  nextCheckAtSecondsAgo?: number | null;
  reconcileAttempts?: number;
  pendingSinceSecondsAgo?: number | null;
  rawStorageMetadata?: Record<string, unknown>;
  lastError?: Record<string, unknown> | null;
  contentHash?: string;
}

function relativeSql(secondsAgo: number | null | undefined): string {
  if (secondsAgo === null || secondsAgo === undefined) return 'NULL';
  return `NOW() - INTERVAL '${secondsAgo} seconds'`;
}

export async function seedRow(opts: SeedOptions): Promise<string> {
  const src = await upsertRawSource(pool, {
    userId: USER, sourceSite: 'drive', provider: 'drive',
  });
  const reg = await registerRawDocument(pool, {
    userId: USER, rawSourceId: src.id, externalId: opts.externalId,
  });
  // `??` doesn't distinguish explicit `null` from `undefined`; honor
  // an explicit `null` so tests can seed null URIs / providers.
  const storageUri = 'storageUri' in opts
    ? opts.storageUri
    : `ipfs://bafy-${opts.externalId}`;
  const storageProvider = 'storageProvider' in opts
    ? opts.storageProvider
    : 'filecoin';
  await pool.query(
    `UPDATE raw_documents
        SET storage_mode = 'managed_blob',
            raw_storage_status = $1,
            storage_uri = $2,
            storage_provider = $3,
            raw_storage_claim_id = $4,
            raw_storage_claimed_at = ${relativeSql(opts.claimedAtSecondsAgo)},
            raw_storage_next_check_at = ${relativeSql(opts.nextCheckAtSecondsAgo)},
            raw_storage_reconcile_attempts = $5,
            raw_storage_pending_since = ${relativeSql(opts.pendingSinceSecondsAgo)},
            raw_storage_metadata = $6::jsonb,
            last_error = $7::jsonb,
            content_hash = $8
      WHERE id = $9`,
    [
      opts.rawStorageStatus ?? 'blob_pending',
      storageUri,
      storageProvider,
      opts.claimId ?? null,
      opts.reconcileAttempts ?? 0,
      JSON.stringify(opts.rawStorageMetadata ?? {}),
      opts.lastError ? JSON.stringify(opts.lastError) : null,
      opts.contentHash ?? 'a'.repeat(64),
      reg.document.id,
    ],
  );
  return reg.document.id;
}

export const DEFAULT_DEPS: Omit<ReconcilerDeps, 'store'> = {
  pool,
  codec: new NoopRawContentCodec(),
  verifyMode: 'head_only',
  batchSize: 10,
  staleAfterMs: 5 * 60 * 1000,
  baseIntervalMs: 60 * 1000,
  backoffMaxMs: 60 * 60 * 1000,
  maxAttempts: 5,
};

export function deps(
  headOverride: (uri: string) => Promise<RawContentHeadResult>,
  provider = 'filecoin',
): ReconcilerDeps {
  return { ...DEFAULT_DEPS, store: makeStore({ head: headOverride, provider }) };
}

/**
 * Reconciler-scoped base class for hand-rolled
 * `FilecoinProviderClient` fakes. Every method except `head`
 * throws — subclasses override the methods the test actually
 * needs. Centralizing the boilerplate keeps each test file
 * focused on the one behavior it asserts (e.g. "unproven head"
 * vs "data_set_id hint propagation") rather than the full
 * provider-client surface.
 */
export class ReconcilerFilecoinTestClientBase implements FilecoinProviderClient {
  readonly provider = 'filecoin' as const;
  readonly driver = 'synapse' as const;
  async put(_i: FilecoinPutInput): Promise<FilecoinPutResult> {
    throw new Error('not used in reconciler test');
  }
  async get(_i: FilecoinGetInput): Promise<FilecoinGetResult> {
    throw new Error('not used in reconciler test');
  }
  async head(_i: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    throw new Error('subclass must override head');
  }
  async delete(_i: FilecoinDeleteInput): Promise<FilecoinDeleteResult> {
    return { deleted: false, semantics: 'tombstone' };
  }
  async verify(_i: FilecoinVerifyInput): Promise<FilecoinVerifyResult> {
    return { verified: false, reason: 'not_used' };
  }
  async checkReadiness(): Promise<ReadonlyArray<FilecoinReadinessCheck>> {
    return [];
  }
  async getServiceMinUploadBytes(): Promise<number> {
    throw new Error('not used in reconciler test');
  }
}
