/**
 * @file Validate tests for the v5 installed-binary diagnostic.
 *   - default (offline) runs all the static checks
 *   - --online adds connectivity (gated; we skip the real network and
 *     prove the gate via the data shape)
 *   - schema parity check confirms top-level keys
 *   - secret redaction sentinel is the documented value
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../commands/setup/validate.js';
import { CONFIG_DIR_MODE, CONFIG_FILE_MODE } from '../config/permissions.js';
import { CliConfigSchema, type CliConfigShape } from '../config/schema.js';
import type { CommandContext } from '../commands/types.js';

function withTempConfigDir<T>(
  config: CliConfigShape | null,
  fn: (file: string, dir: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'atomicmem-validate-'));
  const dir = join(root, 'sub');
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  const file = join(dir, 'config.json');
  if (config) {
    writeFileSync(file, JSON.stringify(CliConfigSchema.parse(config), null, 2), {
      mode: CONFIG_FILE_MODE,
    });
  }
  return fn(file, dir).finally(() => rmSync(root, { recursive: true, force: true }));
}

function makeCtx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'validate',
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

test('validate default (offline) runs every static check and reports ok', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as {
      ok: boolean;
      online: boolean;
      checks: Array<{ id: string; ok: boolean }>;
    };
    assert.equal(data.online, false);
    const ids = data.checks.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      'command_spec.examples',
      'command_spec.present',
      'config.file_safety',
      'config_schema.parity',
      'config_schema.present',
      'output_envelope.shape',
      'package.metadata',
      'secret.redaction',
      'secret.redaction_behavior',
      'skill.core.present',
    ]);
    assert.equal(data.ok, true, JSON.stringify(data.checks, null, 2));
  });
});

test('validate command_spec.examples: examples parse or are intentionally skipped', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const ex = data.checks.find((c) => c.id === 'command_spec.examples');
    assert.ok(ex);
    assert.equal(ex?.ok, true, ex?.detail);
    assert.match(ex?.detail ?? '', /^parsed=\d+ skipped=\d+ failures=0$/);
  });
});

test('validate output_envelope.shape: success and error envelopes carry required v5 fields', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const env = data.checks.find((c) => c.id === 'output_envelope.shape');
    assert.ok(env);
    assert.equal(env?.ok, true, env?.detail);
  });
});

test('validate secret.redaction_behavior: redactProfile actually replaces apiKey with sentinel', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const beh = data.checks.find((c) => c.id === 'secret.redaction_behavior');
    assert.ok(beh);
    assert.equal(beh?.ok, true);
    assert.match(beh?.detail ?? '', /sentinel/);
  });
});

test('validate package.metadata: detects @atomicmemory/cli + atomicmemory bin', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; detail: string }> };
    const pkg = data.checks.find((c) => c.id === 'package.metadata');
    assert.ok(pkg);
    assert.match(pkg?.detail ?? '', /name=@atomicmemory\/cli/);
    assert.match(pkg?.detail ?? '', /bin=atomicmemory/);
  });
});

test('validate config_schema.parity: required top-level keys are present', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean }> };
    const parity = data.checks.find((c) => c.id === 'config_schema.parity');
    assert.ok(parity);
    assert.equal(parity?.ok, true);
  });
});

test('validate secret.redaction: REDACTED_API_KEY sentinel is "***"', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const ctx = makeCtx({ configPath: file, configDir: dir });
    const result = await validate(ctx);
    const data = result.data as { checks: Array<{ id: string; ok: boolean; detail: string }> };
    const sec = data.checks.find((c) => c.id === 'secret.redaction');
    assert.ok(sec);
    assert.equal(sec?.ok, true);
    assert.match(sec?.detail ?? '', /\*\*\*/);
  });
});

test('validate --online adds the provider.connectivity check using the adapter', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    let getAdapterCalls = 0;
    const ctx = makeCtx({
      configPath: file,
      configDir: dir,
      flags: { online: true },
      profile: {
        provider: 'atomicmemory',
        apiUrl: 'http://localhost:3000',
        trustSurface: 'local',
      },
      getAdapter: async () => {
        getAdapterCalls += 1;
        return {
          adapter: {
            getStatus: async () => ({ ok: true, provider: 'atomicmemory' }),
          } as never,
          capabilities: { ingestModes: ['text'], extensions: { package: false } },
        };
      },
    });
    const result = await validate(ctx);
    const data = result.data as {
      online: boolean;
      checks: Array<{ id: string; ok: boolean }>;
    };
    assert.equal(data.online, true);
    assert.equal(getAdapterCalls, 1);
    const conn = data.checks.find((c) => c.id === 'provider.connectivity');
    assert.ok(conn);
    assert.equal(conn?.ok, true);
  });
});
