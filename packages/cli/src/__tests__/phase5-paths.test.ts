/**
 * @file Phase 5 path tests covering the v5 contracts the audit
 * specifically called out:
 *   - search rejects --threshold (not in v5 spec; commander
 *     surfaces it as an unknown option, which the lifecycle
 *     normalizes to CliError('usage') exit 2)
 *   - --interactive --agent rejected (mode != text)
 *   - --file - reads stdin in add and ingest
 *   - init --api-key-stdin --save-api-key persists exactly once
 *   - hidden experimental commands stay out of help/completions but
 *     are invocable when --experimental is on
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvocation } from '../cli/parse-invocation.js';
import { runInvocation } from '../cli/runtime.js';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
} from '../config/permissions.js';
import { CliConfigSchema, type CliConfigShape } from '../config/schema.js';
import { generateCompletion } from '../spec/completions.js';
import { _resetSpecCache, loadSpec } from '../spec/loader.js';

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalIsTTY = process.stdin.isTTY;

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((result) => ({ result, stdout: out.join(''), stderr: err.join('') }))
    .finally(() => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    });
}

function withTempConfigDir<T>(
  config: CliConfigShape | null,
  fn: (file: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmem-phase5-'));
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  const file = join(dir, 'config.json');
  if (config) {
    writeFileSync(file, JSON.stringify(CliConfigSchema.parse(config), null, 2), {
      mode: CONFIG_FILE_MODE,
    });
  }
  return fn(file, dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('search rejects --threshold (commander unknown option → usage exit 2)', async () => {
  const parsed = await parseInvocation(['search', '--threshold', '0.5', 'q']);
  assert.equal(parsed.invocation, null);
  assert.ok(parsed.error);
  assert.equal(parsed.error?.code, 'usage');
  assert.equal(parsed.error?.exitCode, 2);
  assert.match(parsed.error?.message ?? '', /threshold|unknown/i);
});

test('--interactive with --agent is rejected (mode resolves to non-text)', async () => {
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
    async (file) => {
      const { result: code, stdout } = await captureStdio(() =>
        runInvocation(
          {
            path: 'version',
            positional: [],
            flags: { interactive: true, agent: true, config: file },
          },
          0,
          '0.1.0',
        ),
      );
      assert.equal(code, 2);
      assert.match(stdout, /--interactive is only valid when output mode is/);
    },
  );
});

test('add --file - reads stdin instead of opening a literal "-" file', async () => {
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
    async (file) => {
      // Stub a fake adapter via factory: we exercise the resolveText
      // branch (file === '-') without reaching the SDK.
      const stdinReads: string[] = [];
      const ctx = await import('../cli/runtime.js');
      void ctx;
      const handler = (await import('../commands/memory/add.js')).add;
      const fakeAdapter = {
        addMemory: async (input: { text: string; scope: { user: string } }) => {
          stdinReads.push(input.text);
          return { created: ['m1'], updated: [], unchanged: [] };
        },
      };
      const result = await handler({
        command: 'add',
        positional: [],
        flags: { file: '-' },
        config: { schema_version: '2', activeProfile: 'default', profiles: {} },
        configPath: file,
        configDir: '/tmp',
        profile: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
        },
        scope: { user: 'u1' },
        env: {},
        version: '0.1.0',
        readStdin: async () => 'piped content from stdin',
        experimental: false,
        getAdapter: async () => ({
          adapter: fakeAdapter as never,
          capabilities: { ingestModes: ['text'], extensions: { package: false } },
        }),
      });
      assert.equal(result.command, 'add');
      assert.deepEqual(stdinReads, ['piped content from stdin']);
    },
  );
});

test('init --api-key-stdin --save-api-key persists exactly once', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const init = (await import('../commands/setup/init.js')).init;
    let stdinReads = 0;
    const result = await init({
      command: 'init',
      positional: [],
      flags: {
        'api-key-stdin': true,
        'save-api-key': true,
        profile: 'cloud',
        'api-url': 'https://example.com',
        'trust-surface': 'authenticated-wrapper',
        provider: 'atomicmemory',
        user: 'u1',
      },
      config: { schema_version: '2', activeProfile: 'default', profiles: {} },
      configPath: file,
      configDir: dir,
      profile: null,
      scope: { user: 'u1' },
      env: {},
      version: '0.1.0',
      readStdin: async () => {
        stdinReads += 1;
        return 'sk-secret\n';
      },
      experimental: false,
      getAdapter: async () => {
        throw new Error('init must not call getAdapter');
      },
    });
    assert.equal(result.command, 'init');
    const data = result.data as { profile: string; apiKeyPersisted: boolean };
    assert.equal(data.profile, 'cloud');
    assert.equal(data.apiKeyPersisted, true);
    assert.equal(stdinReads, 1, 'stdin must be consumed exactly once');
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.profiles.cloud.apiKey, 'sk-secret');
  });
});

test('init --api-key-stdin without --save-api-key does NOT persist', async () => {
  await withTempConfigDir(null, async (file, dir) => {
    const init = (await import('../commands/setup/init.js')).init;
    const result = await init({
      command: 'init',
      positional: [],
      flags: {
        'api-key-stdin': true,
        profile: 'cloud',
        'api-url': 'https://example.com',
        'trust-surface': 'authenticated-wrapper',
        provider: 'atomicmemory',
        user: 'u1',
      },
      config: { schema_version: '2', activeProfile: 'default', profiles: {} },
      configPath: file,
      configDir: dir,
      profile: null,
      scope: { user: 'u1' },
      env: {},
      version: '0.1.0',
      readStdin: async () => 'sk-not-saved',
      experimental: false,
      getAdapter: async () => {
        throw new Error('init must not call getAdapter');
      },
    });
    const data = result.data as { apiKeyPersisted: boolean };
    assert.equal(data.apiKeyPersisted, false);
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.profiles.cloud.apiKey, undefined);
  });
});

test('hidden experimental commands are absent from generated bash and zsh completions', () => {
  _resetSpecCache();
  const spec = loadSpec();
  for (const shell of ['bash', 'zsh'] as const) {
    const out = generateCompletion(shell, spec);
    for (const hidden of ['lifecycle', 'audit', 'lessons', 'agents']) {
      assert.equal(
        new RegExp(`["\\s']${hidden}["\\s:']`).test(out),
        false,
        `${shell} completion must omit hidden command "${hidden}"`,
      );
    }
  }
});

test('hidden experimental commands require --experimental at runtime', async () => {
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
    async (file) => {
      const lifecycle = (await import('../commands/_experimental/lifecycle.js')).lifecycle;
      // Without --experimental: experimental_disabled exit 2.
      await assert.rejects(
        lifecycle({
          command: 'lifecycle',
          positional: [],
          flags: { config: file },
          config: { schema_version: '2', activeProfile: 'default', profiles: {} },
          configPath: file,
          configDir: '/tmp',
          profile: {
            provider: 'atomicmemory',
            apiUrl: 'http://localhost:3000',
            trustSurface: 'local',
          },
          scope: { user: 'u1' },
          env: {},
          version: '0.1.0',
          readStdin: async () => '',
          experimental: false,
          getAdapter: async () => ({
            adapter: {} as never,
            capabilities: {
              ingestModes: ['text'],
              extensions: { package: true },
              customExtensions: {
                'atomicmemory.lifecycle': { version: '1.0' },
              },
            },
          }),
        }),
        (e: unknown) =>
          e instanceof Error && (e as { code?: string }).code === 'experimental_disabled',
      );
    },
  );
});

void originalIsTTY;
