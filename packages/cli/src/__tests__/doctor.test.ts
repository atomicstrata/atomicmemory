/**
 * @file Doctor tests covering the v5 contract surface:
 *   - stable check IDs and categories
 *   - --quick skips both network AND slow checks
 *   - --offline skips network checks only
 *   - --fix runs the safe repair (mkdir + chmod) on failing fixable
 *     checks; never writes credentials, mutates provider data, or
 *     selects another profile
 *   - SDK resolution dual-path (file: dev vs registry semver)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../commands/setup/doctor/index.js';
import { CHECKS } from '../commands/setup/doctor/checks.js';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  readMode,
} from '../config/permissions.js';
import { CliConfigSchema, type CliConfigShape } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

function withTempConfigDir<T>(
  config: CliConfigShape | null,
  dirMode: number,
  fileMode: number | null,
  fn: (file: string, dir: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'atomicmem-doctor-'));
  const dir = join(root, 'sub');
  mkdirSync(dir, { recursive: true, mode: dirMode });
  chmodSync(dir, dirMode);
  const file = join(dir, 'config.json');
  if (config) {
    writeFileSync(file, JSON.stringify(CliConfigSchema.parse(config), null, 2), {
      mode: fileMode ?? CONFIG_FILE_MODE,
    });
    if (fileMode !== null) chmodSync(file, fileMode);
  }
  return fn(file, dir).finally(() => rmSync(root, { recursive: true, force: true }));
}

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'doctor',
    positional: [],
    flags: {},
    config: { schema_version: '2', activeProfile: 'default', profiles: {} },
    configPath: '/tmp/missing/config.json',
    configDir: '/tmp/missing',
    profile: null,
    scope: {},
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: async () => {
      throw new Error('test should not reach getAdapter');
    },
    ...overrides,
  };
}

test('CHECKS exposes a stable, unique-id catalog with v5 categories', () => {
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate IDs: ${ids}`);
  // Spot-check that every required category has at least one check.
  const categories = new Set(CHECKS.map((c) => c.category));
  for (const required of [
    'env',
    'package_version',
    'config_schema',
    'permissions',
    'active_profile',
    'scope',
    'sdk_resolution',
    'spec_skill_drift',
    'mcp_coexistence',
    'provider_connectivity',
    'provider_auth',
  ]) {
    assert.ok(categories.has(required), `missing category "${required}"`);
  }
});

test('doctor default mode runs every check', async () => {
  await withTempConfigDir(
    {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {
        default: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
        },
      },
    },
    CONFIG_DIR_MODE,
    CONFIG_FILE_MODE,
    async (file, dir) => {
      const ctx = makeCtx({
        configPath: file,
        configDir: dir,
        config: {
          schema_version: '2',
          activeProfile: 'default',
          profiles: {
            default: {
              provider: 'atomicmemory',
              apiUrl: 'http://localhost:3000',
              trustSurface: 'local',
            },
          },
        },
        profile: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
        },
        scope: { user: 'u1' },
        getAdapter: async () => ({
          adapter: { getStatus: async () => ({ ok: true, provider: 'atomicmemory' }) } as never,
          capabilities: { ingestModes: ['text'], extensions: { package: true } },
        }),
      });
      const result = await doctor(ctx);
      const data = result.data as { checks: Array<{ id: string }> };
      const ids = data.checks.map((c) => c.id);
      // All non-skipped checks ran (provider.connectivity is included).
      assert.ok(ids.includes('provider.connectivity'));
      assert.ok(ids.includes('sdk.resolution'));
      assert.ok(ids.includes('mcp.coexistence'));
      assert.equal(ids.at(-1), 'spec_skill.drift');
    },
  );
});

test('doctor --quick skips both network AND slow checks', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { quick: true },
    });
    const result = await doctor(ctx);
    const data = result.data as { mode: string; checks: Array<{ id: string }> };
    assert.equal(data.mode, 'quick');
    const ids = data.checks.map((c) => c.id);
    // provider.connectivity is both network AND slow -> skipped.
    assert.ok(!ids.includes('provider.connectivity'));
  });
});

test('doctor --offline skips network checks only (slow non-network checks still run)', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { offline: true },
    });
    const result = await doctor(ctx);
    const data = result.data as { mode: string; checks: Array<{ id: string }> };
    assert.equal(data.mode, 'offline');
    const ids = data.checks.map((c) => c.id);
    assert.ok(!ids.includes('provider.connectivity'));
    // Non-network checks are still present.
    assert.ok(ids.includes('sdk.resolution'));
    assert.ok(ids.includes('spec_skill.drift'));
    assert.ok(ids.includes('mcp.coexistence'));
  });
});

test('doctor --fix tightens config dir/file permissions to 0700/0600', async () => {
  await withTempConfigDir(
    {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {
        default: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
        },
      },
    },
    0o755, // overly permissive dir
    0o644, // overly permissive file
    async (file, dir) => {
      assert.equal(readMode(dir), 0o755);
      assert.equal(readMode(file), 0o644);

      const ctx = makeCtx({
        configPath: file,
        configDir: dir,
        flags: { fix: true, offline: true },
        config: {
          schema_version: '2',
          activeProfile: 'default',
          profiles: {
            default: {
              provider: 'atomicmemory',
              apiUrl: 'http://localhost:3000',
              trustSurface: 'local',
            },
          },
        },
      });
      const result = await doctor(ctx);
      const data = result.data as {
        fix: boolean;
        fixedAny: boolean;
        checks: Array<{ id: string; ok: boolean; fixed?: boolean }>;
      };
      assert.equal(data.fix, true);
      assert.equal(data.fixedAny, true);
      const perm = data.checks.find((c) => c.id === 'permissions.config');
      assert.ok(perm);
      assert.equal(perm?.ok, true);
      assert.equal(perm?.fixed, true);
      assert.equal(readMode(dir), CONFIG_DIR_MODE);
      assert.equal(readMode(file), CONFIG_FILE_MODE);
    },
  );
});

test('doctor --fix never writes a profile when active_profile is missing (safe-repair rule)', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { fix: true, offline: true },
    });
    const result = await doctor(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; fixed?: boolean }> };
    const profileCheck = data.checks.find((c) => c.id === 'active_profile.present');
    assert.ok(profileCheck);
    // active_profile is not fixable per the v5 safe-repair rule.
    assert.equal(profileCheck?.ok, false);
    assert.equal(profileCheck?.fixed, undefined);
  });
});

test('doctor sdk.resolution detects the local file: dev install path', async () => {
  // The CLI workspace ships with @atomicmemory/sdk as a
  // sibling file: dependency that has been built (dist/ exists). The
  // check should report ok=true with a "(built)" detail.
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { offline: true },
    });
    const result = await doctor(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const sdk = data.checks.find((c) => c.id === 'sdk.resolution');
    assert.ok(sdk);
    assert.equal(sdk?.ok, true, sdk?.detail);
    assert.match(sdk?.detail ?? '', /file:|registry/);
  });
});

test('doctor provider.auth flags hosted apiUrl without authenticated-wrapper trustSurface', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { offline: true },
      profile: {
        provider: 'atomicmemory',
        apiUrl: 'https://hosted.example.com',
        trustSurface: 'local',
      },
    });
    const result = await doctor(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const auth = data.checks.find((c) => c.id === 'provider.auth');
    assert.ok(auth);
    assert.equal(auth?.ok, false);
    assert.match(auth?.detail ?? '', /authenticated-wrapper/);
  });
});

test('doctor provider.auth passes when hosted apiUrl uses authenticated-wrapper trustSurface', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { offline: true },
      profile: {
        provider: 'atomicmemory',
        apiUrl: 'https://hosted.example.com',
        trustSurface: 'authenticated-wrapper',
      },
    });
    const result = await doctor(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean }> };
    const auth = data.checks.find((c) => c.id === 'provider.auth');
    assert.ok(auth);
    assert.equal(auth?.ok, true);
  });
});

test('doctor mcp.coexistence reports OK when atomicmemory-mcp is not installed alongside', async () => {
  await withTempConfigDir(null, CONFIG_DIR_MODE, null, async (file, dir) => {
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { offline: true },
    });
    const result = await doctor(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const mcp = data.checks.find((c) => c.id === 'mcp.coexistence');
    assert.ok(mcp);
    // In the test workspace there is no atomicmemory-mcp dependency on
    // packages/cli, so the check should report "no coexistence
    // concern".
    assert.equal(mcp?.ok, true);
    assert.match(mcp?.detail ?? '', /not installed|does not shadow/);
  });
});
