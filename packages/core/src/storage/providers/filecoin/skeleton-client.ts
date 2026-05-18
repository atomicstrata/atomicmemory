/**
 * @file Test-only `FilecoinProviderClient` whose every
 * operation throws `FilecoinNotImplementedError` and whose
 * `checkReadiness` reports every required check as
 * `'unknown' / 'not_implemented'`.
 *
 * Used by tests that need to construct a `FilecoinRawContentStore`
 * without standing up a real Synapse instance. The test
 * "bare selection" runtime path (`createFilecoinStorageBackend(null)`)
 * has been removed — `src/storage/factory.ts` now throws when
 * `rawStorageProvider='filecoin'` and `filecoinProvider` is null,
 * so this class never reaches the production composition root.
 *
 * The real Synapse-backed implementation lives in
 * `synapse-client.ts` and is constructed via
 * `synapse-construction.ts` from a parsed `FilecoinProviderConfig`.
 */

import { FilecoinNotImplementedError } from './errors.js';
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
  FilecoinReadinessNetwork,
  FilecoinVerifyInput,
  FilecoinVerifyResult,
} from './provider-client.js';
import { FILECOIN_READINESS_REQUIRED_CHECKS } from './readiness.js';

export class SkeletonFilecoinProviderClient implements FilecoinProviderClient {
  readonly provider = 'filecoin' as const;
  readonly driver = 'synapse' as const;
  async put(_input: FilecoinPutInput): Promise<FilecoinPutResult> {
    throw new FilecoinNotImplementedError('put');
  }
  async get(_input: FilecoinGetInput): Promise<FilecoinGetResult> {
    throw new FilecoinNotImplementedError('get');
  }
  async head(_input: FilecoinHeadInput): Promise<FilecoinHeadResult> {
    throw new FilecoinNotImplementedError('head');
  }
  async delete(_input: FilecoinDeleteInput): Promise<FilecoinDeleteResult> {
    throw new FilecoinNotImplementedError('delete');
  }
  async verify(_input: FilecoinVerifyInput): Promise<FilecoinVerifyResult> {
    throw new FilecoinNotImplementedError('verify');
  }
  /**
   * The test client reports every documented required check as
   * `'unknown' / 'not_implemented'`. The aggregate
   * (`aggregateFilecoinReadiness`) collapses this to
   * `ready: false`, which is exactly the contract for a
   * non-Synapse-backed deployment.
   */
  async checkReadiness(
    _network: FilecoinReadinessNetwork,
  ): Promise<ReadonlyArray<FilecoinReadinessCheck>> {
    return FILECOIN_READINESS_REQUIRED_CHECKS.map((name) => ({
      name,
      status: 'unknown' as const,
      errorCode: 'not_implemented',
    }));
  }
  async getServiceMinUploadBytes(): Promise<number> {
    throw new FilecoinNotImplementedError('getServiceMinUploadBytes');
  }
}
