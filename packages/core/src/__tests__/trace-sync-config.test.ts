/**
 * Cloud trace sync env parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCloudTraceSyncConfig } from '../cloud/trace-sync-config.js';

const tracked = [
  'CLOUD_TRACE_SYNC_ENABLED',
  'ATOMICMEMORY_API_URL',
  'ATOMICMEMORY_API_KEY',
  'CORE_INSTANCE_ID',
] as const;

const original = Object.fromEntries(tracked.map((name) => [name, process.env[name]])) as Record<
  (typeof tracked)[number],
  string | undefined
>;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  for (const name of tracked) delete process.env[name];
});

afterEach(() => {
  for (const name of tracked) restore(name, original[name]);
});

describe('parseCloudTraceSyncConfig', () => {
  it('returns null when all vars are absent', () => {
    expect(parseCloudTraceSyncConfig()).toBeNull();
  });

  it('returns null when explicitly disabled even with sibling vars present', () => {
    process.env.CLOUD_TRACE_SYNC_ENABLED = 'false';
    process.env.ATOMICMEMORY_API_URL = 'https://api.test';
    process.env.ATOMICMEMORY_API_KEY = 'amc_test_key';
    expect(parseCloudTraceSyncConfig()).toBeNull();
  });

  it('loads config when enabled with credentials', () => {
    process.env.CLOUD_TRACE_SYNC_ENABLED = 'true';
    process.env.ATOMICMEMORY_API_URL = 'https://api.test/';
    process.env.ATOMICMEMORY_API_KEY = 'amc_test_key';
    const cfg = parseCloudTraceSyncConfig();
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.apiUrl).toBe('https://api.test');
    expect(cfg?.claimStaleMs).toBeGreaterThan(0);
    expect(cfg?.maxPending).toBeGreaterThan(0);
  });

  it('throws on partial config without explicit disable', () => {
    process.env.ATOMICMEMORY_API_URL = 'https://api.test';
    expect(() => parseCloudTraceSyncConfig()).toThrow(/Partial Cloud trace sync/);
  });
});
