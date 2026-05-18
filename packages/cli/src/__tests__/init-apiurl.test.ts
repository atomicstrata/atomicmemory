/**
 * @file v5 contract: `init` for a brand-new profile MUST refuse to
 * write a hardcoded provider default. The earlier implementation
 * silently persisted `http://localhost:3000` when no `--api-url` was
 * given, which is a footgun (writes "config done" while pointing at a
 * URL that may not exist). Required input chain:
 *   --api-url > ATOMICMEMORY_API_URL > existing profile.apiUrl
 * Missing all three for a fresh profile fails with `missing_input`.
 * Fresh profiles also require an explicit trust surface:
 *   --trust-surface > ATOMICMEMORY_TRUST_SURFACE > existing profile
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../types.js';
import { init } from '../commands/setup/init.js';
import { CONFIG_DIR_MODE } from '../config/permissions.js';
import { emptyConfig } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

function withTmp<T>(fn: (cfgPath: string, dir: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'atomicmem-init-apiurl-'));
  const dir = join(root, 'sub');
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  const cfgPath = join(dir, 'config.json');
  return fn(cfgPath, dir).finally(() => rmSync(root, { recursive: true, force: true }));
}

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'init',
    positional: [],
    flags: {},
    config: emptyConfig(),
    configPath: '/tmp/missing/config.json',
    configDir: '/tmp/missing',
    profile: null,
    scope: {},
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: async () => {
      throw new Error('init does not call getAdapter');
    },
    ...overrides,
  };
}

test('init for a fresh profile fails when no apiUrl is supplied', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: { profile: 'default' },
    });
    await assert.rejects(
      () => init(ctx),
      (err) =>
        err instanceof CliError &&
        err.code === 'missing_input' &&
        /requires --api-url/.test(err.message),
    );
    assert.equal(existsSync(cfgPath), false, 'no config file should have been written');
  });
});

test('init reads ATOMICMEMORY_API_URL when --api-url is absent', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: { profile: 'default', 'trust-surface': 'authenticated-wrapper' },
      env: { ATOMICMEMORY_API_URL: 'https://env.example.invalid/v1' },
    });
    const result = await init(ctx);
    assert.equal(
      (result.data as { profile: string }).profile,
      'default',
    );
    const written = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      profiles: Record<string, { apiUrl: string }>;
    };
    assert.equal(written.profiles.default!.apiUrl, 'https://env.example.invalid/v1');
  });
});

test('init for a fresh profile fails when no trust surface is supplied', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: {
        profile: 'default',
        'api-url': 'https://core.example.invalid/v1',
      },
    });
    await assert.rejects(
      () => init(ctx),
      (err) =>
        err instanceof CliError &&
        err.code === 'missing_input' &&
        /requires --trust-surface/.test(err.message),
    );
    assert.equal(existsSync(cfgPath), false, 'no config file should have been written');
  });
});

test('init reports invalid trust surface values explicitly', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: {
        profile: 'default',
        'api-url': 'https://core.example.invalid/v1',
        'trust-surface': 'oops',
      },
    });
    await assert.rejects(
      () => init(ctx),
      (err) =>
        err instanceof CliError &&
        err.code === 'usage' &&
        /must be local\|self-hosted\|authenticated-wrapper/.test(err.message),
    );
    assert.equal(existsSync(cfgPath), false, 'no config file should have been written');
  });
});

test('init never writes the localhost:3000 fallback', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: { profile: 'default' },
    });
    await init(ctx).catch(() => undefined);
    if (existsSync(cfgPath)) {
      const written = readFileSync(cfgPath, 'utf8');
      assert.equal(/localhost:3000/.test(written), false, written);
    }
  });
});

test('init preserves an existing profile apiUrl when --api-url is omitted', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: { profile: 'default', force: true },
      config: {
        schema_version: '2',
        activeProfile: 'default',
        profiles: {
          default: {
            provider: 'atomicmemory',
            apiUrl: 'https://prior.example.invalid/v1',
            trustSurface: 'self-hosted',
          },
        },
      },
    });
    await init(ctx);
    const written = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      profiles: Record<string, { apiUrl: string; trustSurface: string }>;
    };
    assert.equal(written.profiles.default!.apiUrl, 'https://prior.example.invalid/v1');
    assert.equal(written.profiles.default!.trustSurface, 'self-hosted');
  });
});

test('init persists --trust-surface when supplied', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: {
        profile: 'cloud',
        'api-url': 'https://cloud.example.invalid/v1',
        'trust-surface': 'authenticated-wrapper',
      },
    });
    await init(ctx);
    const written = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      profiles: Record<string, { trustSurface: string }>;
    };
    assert.equal(written.profiles.cloud!.trustSurface, 'authenticated-wrapper');
  });
});

test('init reads ATOMICMEMORY_TRUST_SURFACE when --trust-surface is absent', async () => {
  await withTmp(async (cfgPath, dir) => {
    const ctx = makeCtx({
      configPath: cfgPath,
      configDir: dir,
      flags: {
        profile: 'cloud',
        'api-url': 'https://cloud.example.invalid/v1',
      },
      env: { ATOMICMEMORY_TRUST_SURFACE: 'self-hosted' },
    });
    await init(ctx);
    const written = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      profiles: Record<string, { trustSurface: string }>;
    };
    assert.equal(written.profiles.cloud!.trustSurface, 'self-hosted');
  });
});
