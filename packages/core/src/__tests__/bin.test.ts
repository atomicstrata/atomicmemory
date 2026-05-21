/**
 * Tests for the published `atomicmemory-core` npm binary entry point.
 *
 * These cover command dispatch only; migration behavior itself lives in the
 * migration API test suite. The key regression guard is that `migrate` must
 * call the programmatic API directly instead of importing the standalone
 * migration CLI, which reparses the original process argv.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
}));

vi.mock('../db/migration-api.js', () => ({
  migrate: mocks.migrate,
}));

vi.mock('../db/migrate.js', () => {
  throw new Error('standalone migration CLI must not be imported by bin.ts');
});

import { parseCliArgs, runCommand } from '../bin.js';

describe('core CLI entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.migrate.mockResolvedValue({
      ranSchemaSql: true,
      schemaVersion: {
        sdkVersion: '1.0.6',
        schemaSha256: 'abcdef1234567890',
        appliedAt: new Date('2026-05-20T00:00:00.000Z'),
        notes: null,
      },
      reconciledEmbeddingDimension: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the local migrate command without passing command text onward', () => {
    expect(parseCliArgs(['migrate', '--profile', 'local'])).toEqual({
      command: 'migrate',
      help: false,
      profile: 'local',
    });
  });

  it('runs migrations through the programmatic API', async () => {
    await runCommand('migrate');

    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.migrate).toHaveBeenCalledWith();
    expect(console.log).toHaveBeenCalledWith(
      '[migrate] Migration complete (ranSchemaSql=true, version=1.0.6, sha=abcdef123456..., reconciledEmbeddingDimension=false).',
    );
  });
});
