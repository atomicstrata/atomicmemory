/**
 * @file Shared in-process fakes + constants for the
 * `SynapseFilecoinProviderClient` read-path test files
 * (`synapse-client-rw.test.ts` + `synapse-client-delete.test.ts`).
 *
 * Lives in `__tests__/` so the import-boundary scan still allows
 * vitest's `vi` (the TEST_TIME_PACKAGES allowlist applies inside
 * the provider directory). The filename intentionally avoids the
 * `.test.ts` suffix so vitest's discovery pattern (the
 * `*.test.ts` glob in `vitest.config.ts`) skips it as runnable
 * tests — these are pure helpers consumed by the sibling test
 * files via direct import.
 */

import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { PieceStatus } from '@filoz/synapse-sdk';
import type {
  SynapseContextLike,
  SynapseDataSetInfoLike,
  SynapseLike,
  SynapseStorageLike,
} from '../synapse-client.js';
import { REAL_PIECE_CID_A } from '../../../__tests__/filecoin-cid-fixtures.js';
import { formatPieceUri } from '../uri.js';

export function fakePieceStatus(overrides: Partial<PieceStatus> = {}): PieceStatus {
  return {
    dataSetLastProven: new Date('2026-05-13T00:00:00Z'),
    dataSetNextProofDue: new Date('2026-05-13T01:00:00Z'),
    retrievalUrl: 'https://internal-provider/ipfs/baga-x',
    pieceId: 7n,
    inChallengeWindow: false,
    isProofOverdue: false,
    ...overrides,
  };
}

export interface ContextSetup {
  readonly dataSetId: bigint;
  readonly pieceStatus?: PieceStatus | null;
  readonly statusError?: unknown;
  readonly deleteHash?: `0x${string}`;
  readonly deleteError?: unknown;
}

export function buildFakeContext(setup: ContextSetup): SynapseContextLike {
  const pieceStatus = vi.fn(async () => {
    if (setup.statusError !== undefined) throw setup.statusError;
    return setup.pieceStatus ?? null;
  });
  const deletePiece = vi.fn(async () => {
    if (setup.deleteError !== undefined) throw setup.deleteError;
    return (setup.deleteHash ?? '0xdeadbeef') as `0x${string}`;
  });
  return {
    dataSetId: setup.dataSetId,
    pieceStatus,
    deletePiece,
  };
}

export interface SynapseSetup {
  readonly download?: { bytes?: Uint8Array; error?: unknown; delayMs?: number };
  readonly dataSets?: ReadonlyArray<SynapseDataSetInfoLike>;
  readonly contexts?: ReadonlyMap<bigint, SynapseContextLike>;
}

export function buildFakeSynapse(setup: SynapseSetup): {
  readonly synapse: SynapseLike;
  readonly downloadSpy: ReturnType<typeof vi.fn>;
  readonly createContextSpy: ReturnType<typeof vi.fn>;
} {
  const downloadSpy = vi.fn(async () => {
    if (setup.download?.delayMs) {
      await new Promise((r) => setTimeout(r, setup.download!.delayMs));
    }
    if (setup.download?.error !== undefined) throw setup.download.error;
    return setup.download?.bytes ?? new Uint8Array();
  });
  const createContextSpy = vi.fn(async ({ dataSetId }: { dataSetId?: bigint }) => {
    if (dataSetId === undefined) {
      throw new Error('createContext called without dataSetId in test');
    }
    const ctx = setup.contexts?.get(dataSetId);
    if (!ctx) throw new Error(`no fake context for dataSetId=${dataSetId}`);
    return ctx;
  });
  const findDataSetsSpy = vi.fn(async () => setup.dataSets ?? []);
  const storage: SynapseStorageLike = {
    upload: vi.fn(async () => {
      throw new Error('not used');
    }) as unknown as SynapseStorageLike['upload'],
    download: downloadSpy as unknown as SynapseStorageLike['download'],
    findDataSets: findDataSetsSpy as unknown as SynapseStorageLike['findDataSets'],
    createContext: createContextSpy as unknown as SynapseStorageLike['createContext'],
    getStorageInfo: vi.fn(async () => {
      throw new Error('not used in rw tests');
    }) as unknown as SynapseStorageLike['getStorageInfo'],
    getUploadCosts: vi.fn(async () => {
      throw new Error('not used in rw tests');
    }) as unknown as SynapseStorageLike['getUploadCosts'],
  };
  return {
    synapse: {
      storage,
      chain: { id: 314159 },
      client: { getChainId: async () => 314159 },
    },
    downloadSpy,
    createContextSpy,
  };
}

export const HELLO = Buffer.from('hello world');
export const HELLO_HASH = createHash('sha256').update(HELLO).digest('hex');
/**
 * Canonical PieceCID used across the unit-test suite. Sourced
 * from `REAL_PIECE_CIDS` — round-trips through
 * `@filoz/synapse-core/piece.asPieceCID`, so any test that
 * threads it through the real provider boundary
 * (`formatPieceUri`, `parsePieceUri`, `FilecoinRawContentStore.put`)
 * cannot get false-positive validation from a shape-only synthetic.
 */
export const PIECE_CID = REAL_PIECE_CID_A;
export const PIECE_URI = formatPieceUri(PIECE_CID);
