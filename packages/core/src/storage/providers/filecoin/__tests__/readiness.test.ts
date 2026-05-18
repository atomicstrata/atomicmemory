/**
 * @file Focused tests for `FilecoinReadiness` — INTERNAL-only.
 *
 * Pins the readiness contract:
 *
 *   - `aggregateFilecoinReadiness` is a pure function over the
 *     supplied checks; `ready=true` iff every check passed.
 *   - `checkFilecoinReadiness` always returns the documented
 *     required-check names in order with `'unknown'` /
 *     `'not_implemented'` defaults.
 *   - The result object NEVER carries wallet addresses, balances,
 *     allowances, provider auth payloads, or raw vendor messages
 *     (sanitization rule). The closed surface is `provider`,
 *     `driver`, `network`, `ready`, and `checks[]`; each check
 *     emits only `name`, `status`, and an opaque `errorCode`.
 *
 * Reachability rule: this module must NOT
 * be wired into any public HTTP route, OpenAPI schema, or SDK
 * fixture. A separate import-boundary test
 * enforces that no route layer imports from `providers/filecoin/`.
 * This file only pins the interface shape.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateFilecoinReadiness,
  checkFilecoinReadiness,
  FILECOIN_READINESS_REQUIRED_CHECKS,
  type FilecoinReadinessCheck,
} from '../readiness.js';
import { SkeletonFilecoinProviderClient } from '../skeleton-client.js';

describe('aggregateFilecoinReadiness', () => {
  it('fails closed for an empty check list (no checks ⇒ not ready)', () => {
    expect(aggregateFilecoinReadiness([])).toBe(false);
  });

  it('returns true when every check passed', () => {
    const checks: ReadonlyArray<FilecoinReadinessCheck> = [
      { name: 'a', status: 'passed' },
      { name: 'b', status: 'passed' },
    ];
    expect(aggregateFilecoinReadiness(checks)).toBe(true);
  });

  it('returns false when any check is unknown', () => {
    expect(
      aggregateFilecoinReadiness([
        { name: 'a', status: 'passed' },
        { name: 'b', status: 'unknown', errorCode: 'not_implemented' },
      ]),
    ).toBe(false);
  });

  it('returns false when any check failed', () => {
    expect(
      aggregateFilecoinReadiness([
        { name: 'a', status: 'passed' },
        { name: 'b', status: 'failed', errorCode: 'something_broke' },
      ]),
    ).toBe(false);
  });
});

describe('checkFilecoinReadiness — stub client', () => {
  const client = new SkeletonFilecoinProviderClient();

  it('always lists the documented required check names in stable order', async () => {
    const result = await checkFilecoinReadiness(client, 'calibration');
    expect(result.checks.map((c) => c.name)).toEqual([
      ...FILECOIN_READINESS_REQUIRED_CHECKS,
    ]);
  });

  it("stubs every check as status='unknown' / errorCode='not_implemented'", async () => {
    const result = await checkFilecoinReadiness(client, 'calibration');
    for (const check of result.checks) {
      expect(check.status).toBe('unknown');
      expect(check.errorCode).toBe('not_implemented');
    }
  });

  it('aggregates ready=false under the all-unknown stub', async () => {
    const calibration = await checkFilecoinReadiness(client, 'calibration');
    expect(calibration.ready).toBe(false);
    const mainnet = await checkFilecoinReadiness(client, 'mainnet');
    expect(mainnet.ready).toBe(false);
  });

  it('reports provider=filecoin / driver=synapse / requested network', async () => {
    const result = await checkFilecoinReadiness(client, 'mainnet');
    expect(result.provider).toBe('filecoin');
    expect(result.driver).toBe('synapse');
    expect(result.network).toBe('mainnet');
  });
});

describe('FilecoinReadiness — sanitization', () => {
  it("the result object's closed surface carries no PII-shaped fields", async () => {
    const result = await checkFilecoinReadiness(new SkeletonFilecoinProviderClient(), 'calibration');
    const json = JSON.stringify(result);
    // wallet addresses, balances, allowances, provider auth, raw
    // vendor messages: none of these strings can appear in the
    // closed shape we expose.
    for (const banned of [
      '0x', // 0x-prefixed addresses or keys
      'wallet',
      'balance',
      'allowance',
      'authorization',
      'private_key',
      'signed_request',
      'synapse_response',
      'rpc_error',
    ]) {
      expect(json.toLowerCase()).not.toContain(banned);
    }
  });

  it('check entries expose only name / status / errorCode keys', async () => {
    const result = await checkFilecoinReadiness(new SkeletonFilecoinProviderClient(), 'calibration');
    for (const check of result.checks) {
      expect(Object.keys(check).sort()).toEqual(['errorCode', 'name', 'status']);
    }
  });

  it('top-level result exposes only the documented closed surface', async () => {
    const result = await checkFilecoinReadiness(new SkeletonFilecoinProviderClient(), 'mainnet');
    expect(Object.keys(result).sort()).toEqual(
      ['checks', 'driver', 'network', 'provider', 'ready'].sort(),
    );
  });
});
