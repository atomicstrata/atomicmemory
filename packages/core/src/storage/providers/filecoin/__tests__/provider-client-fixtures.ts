/**
 * @file Vendor-free `FilecoinProviderClient` fakes for adapter-
 * level tests.
 *
 * Crucially this file does NOT import `@filoz/synapse-sdk`,
 * `viem`, or any other vendor package. The contract tests built
 * against this fixture exercise `FilecoinRawContentStore` purely
 * through the `FilecoinProviderClient` boundary — the import
 * graph of this fixture is itself the enforcement of the
 * "adapter is vendor-free" invariant.
 *
 * If you need a Synapse-SDK-shaped fake (`SynapseLike`,
 * `SynapseContextLike`, etc.), use `synapse-client-rw-fixtures.ts`
 * instead. This module deliberately stays narrower.
 *
 * Filename is `*-fixtures.ts` (no `.test.ts`) so vitest's
 * `*.test.ts` discovery glob in `vitest.config.ts` skips it as
 * runnable tests — these are pure helpers consumed by sibling
 * test files via direct import.
 */

import { vi } from 'vitest';
import type {
  FilecoinDeleteInput,
  FilecoinDeleteResult,
  FilecoinDriverName,
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
} from '../provider-client.js';

/**
 * Default minimum-upload value returned by the fake's
 * `getServiceMinUploadBytes` when the test doesn't override it.
 *
 * THIS IS A FIXTURE-ONLY CONVENIENCE VALUE — NOT PRODUCTION
 * TRUTH. The canonical Synapse value lives in
 * `@filoz/synapse-sdk`'s `SIZE_CONSTANTS.MIN_UPLOAD_SIZE` and is
 * consumed only by the live calibration smoke test. The number
 * here exists so unit tests don't need to plumb a fake size
 * through every constructor. Intentionally NOT exported: tests
 * get this value implicitly by omitting
 * `behavior.getServiceMinUploadBytes`; if a future test needs
 * to assert against the literal it should bind its own constant.
 */
const DEFAULT_FAKE_MIN_UPLOAD_BYTES = 127;

export interface FakeProviderClientBehavior {
  readonly put?: FilecoinPutResult | ((input: FilecoinPutInput) => Promise<FilecoinPutResult>);
  readonly get?: FilecoinGetResult | ((input: FilecoinGetInput) => Promise<FilecoinGetResult>);
  readonly head?: FilecoinHeadResult | ((input: FilecoinHeadInput) => Promise<FilecoinHeadResult>);
  readonly delete?:
    | FilecoinDeleteResult
    | ((input: FilecoinDeleteInput) => Promise<FilecoinDeleteResult>);
  readonly verify?:
    | FilecoinVerifyResult
    | ((input: FilecoinVerifyInput) => Promise<FilecoinVerifyResult>);
  readonly checkReadiness?:
    | ReadonlyArray<FilecoinReadinessCheck>
    | (() => Promise<ReadonlyArray<FilecoinReadinessCheck>>);
  readonly getServiceMinUploadBytes?: number | (() => Promise<number>);
}

export interface FakeProviderClientOptions {
  readonly driver?: FilecoinDriverName;
}

export interface BuiltFakeProviderClient {
  readonly client: FilecoinProviderClient;
  readonly putSpy: ReturnType<typeof vi.fn>;
  readonly getSpy: ReturnType<typeof vi.fn>;
  readonly headSpy: ReturnType<typeof vi.fn>;
  readonly deleteSpy: ReturnType<typeof vi.fn>;
  readonly verifySpy: ReturnType<typeof vi.fn>;
  readonly checkReadinessSpy: ReturnType<typeof vi.fn>;
  readonly getServiceMinUploadBytesSpy: ReturnType<typeof vi.fn>;
}

/**
 * Build an in-process fake `FilecoinProviderClient`. Every method
 * is a `vi.fn` spy whose body delegates to the corresponding
 * `behavior.*` entry: a function is called with the input, a
 * literal value is returned, an undefined entry throws
 * `'<method> not configured'`. The fake's `driver` defaults to
 * `'synapse'`; pass `opts.driver` to exercise the closed-union
 * boundary against a non-Synapse literal (e.g. `'filecoin_pin'`).
 */
export function buildFakeFilecoinProviderClient(
  behavior: FakeProviderClientBehavior = {},
  opts: FakeProviderClientOptions = {},
): BuiltFakeProviderClient {
  const putSpy = vi.fn(async (input: FilecoinPutInput): Promise<FilecoinPutResult> => {
    if (typeof behavior.put === 'function') return behavior.put(input);
    if (behavior.put) return behavior.put;
    throw new Error('put not configured');
  });
  const getSpy = vi.fn(async (input: FilecoinGetInput): Promise<FilecoinGetResult> => {
    if (typeof behavior.get === 'function') return behavior.get(input);
    if (behavior.get) return behavior.get;
    throw new Error('get not configured');
  });
  const headSpy = vi.fn(async (input: FilecoinHeadInput): Promise<FilecoinHeadResult> => {
    if (typeof behavior.head === 'function') return behavior.head(input);
    if (behavior.head) return behavior.head;
    throw new Error('head not configured');
  });
  const deleteSpy = vi.fn(async (input: FilecoinDeleteInput): Promise<FilecoinDeleteResult> => {
    if (typeof behavior.delete === 'function') return behavior.delete(input);
    if (behavior.delete) return behavior.delete;
    throw new Error('delete not configured');
  });
  const verifySpy = vi.fn(async (input: FilecoinVerifyInput): Promise<FilecoinVerifyResult> => {
    if (typeof behavior.verify === 'function') return behavior.verify(input);
    if (behavior.verify) return behavior.verify;
    throw new Error('verify not configured');
  });
  const checkReadinessSpy = vi.fn(
    async (): Promise<ReadonlyArray<FilecoinReadinessCheck>> => {
      if (typeof behavior.checkReadiness === 'function') return behavior.checkReadiness();
      if (behavior.checkReadiness) return behavior.checkReadiness;
      return [];
    },
  );
  const getServiceMinUploadBytesSpy = vi.fn(async (): Promise<number> => {
    if (typeof behavior.getServiceMinUploadBytes === 'function') {
      return behavior.getServiceMinUploadBytes();
    }
    if (typeof behavior.getServiceMinUploadBytes === 'number') {
      return behavior.getServiceMinUploadBytes;
    }
    return DEFAULT_FAKE_MIN_UPLOAD_BYTES;
  });
  const client: FilecoinProviderClient = {
    provider: 'filecoin',
    driver: opts.driver ?? 'synapse',
    put: putSpy as unknown as FilecoinProviderClient['put'],
    get: getSpy as unknown as FilecoinProviderClient['get'],
    head: headSpy as unknown as FilecoinProviderClient['head'],
    delete: deleteSpy as unknown as FilecoinProviderClient['delete'],
    verify: verifySpy as unknown as FilecoinProviderClient['verify'],
    checkReadiness: checkReadinessSpy as unknown as FilecoinProviderClient['checkReadiness'],
    getServiceMinUploadBytes:
      getServiceMinUploadBytesSpy as unknown as FilecoinProviderClient['getServiceMinUploadBytes'],
  };
  return {
    client,
    putSpy,
    getSpy,
    headSpy,
    deleteSpy,
    verifySpy,
    checkReadinessSpy,
    getServiceMinUploadBytesSpy,
  };
}
