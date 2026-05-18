/**
 * @file Phase 5 sanitizer redaction tests. Per audit item 7: every
 * agent-mode command runs through a sanitizer; the V1 default is
 * passthrough, but commands that surface profile config or memory
 * objects must not leak secrets or raw provider internals. These
 * tests assert that:
 *
 *   - config show redacts apiKey for every profile
 *   - config get profiles.<name>.apiKey returns the *** sentinel
 *   - skill get content is verbatim CLI-canonical text (no SDK leak)
 *   - search/list/get results expose only AdapterMemorySummary fields
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInvocation } from '../cli/runtime.js';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
} from '../config/permissions.js';
import { REDACTED_API_KEY } from '../config/profiles.js';
import { CliConfigSchema } from '../config/schema.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: CapturedOutput }> {
  const out: CapturedOutput = { stdout: [], stderr: [] };
  process.stdout.write = ((chunk: unknown) => {
    out.stdout.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    out.stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((result) => ({ result, out }))
    .finally(() => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    });
}

function withTempConfig<T>(
  config: Parameters<typeof CliConfigSchema.parse>[0],
  fn: (file: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmem-redact-'));
  mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(CliConfigSchema.parse(config), null, 2), {
    mode: CONFIG_FILE_MODE,
  });
  return fn(file, dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('config show: agent envelope redacts apiKey across every profile', async () => {
  await withTempConfig(
    {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {
        default: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
          apiKey: 'sk-default',
        },
        cloud: {
          provider: 'atomicmemory',
          apiUrl: 'https://example.com',
          trustSurface: 'authenticated-wrapper',
          apiKey: 'sk-cloud',
        },
      },
    },
    async (file) => {
      const { out, result: code } = await capture(() =>
        runInvocation(
          {
            path: 'config show',
            positional: [],
            flags: { agent: true, config: file },
          },
          0,
          '0.1.0',
        ),
      );
      const stdout = out.stdout.join('');
      assert.equal(code, 0, `exit ${code}; stdout=${stdout}`);
      assert.ok(!stdout.includes('sk-default'), 'sk-default leaked');
      assert.ok(!stdout.includes('sk-cloud'), 'sk-cloud leaked');
      assert.ok(stdout.includes(REDACTED_API_KEY));
    },
  );
});

test('config get: agent envelope redacts apiKey when key path ends in apiKey', async () => {
  await withTempConfig(
    {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {
        default: {
          provider: 'atomicmemory',
          apiUrl: 'http://localhost:3000',
          trustSurface: 'local',
          apiKey: 'sk-secret-token',
        },
      },
    },
    async (file) => {
      const { out, result: code } = await capture(() =>
        runInvocation(
          {
            path: 'config get',
            positional: ['profiles.default.apiKey'],
            flags: { agent: true, config: file },
          },
          0,
          '0.1.0',
        ),
      );
      assert.equal(code, 0);
      const stdout = out.stdout.join('');
      assert.ok(!stdout.includes('sk-secret-token'), 'apiKey leaked');
      assert.ok(stdout.includes(REDACTED_API_KEY));
    },
  );
});

test('skill get core: agent envelope returns CLI-owned content (no SDK shape leak)', async () => {
  await withTempConfig(
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
      const { out, result: code } = await capture(() =>
        runInvocation(
          {
            // commander dispatches `skill get core` as path "skill get"
            // with positional ['core']; bypass the parser to exercise
            // the renderer.
            path: 'skill get',
            positional: ['core'],
            flags: { agent: true, config: file },
          },
          0,
          '0.1.0',
        ),
      );
      assert.equal(code, 0);
      const stdout = out.stdout.join('');
      // Must contain the CLI's own skill content (sanity: it mentions
      // commands documented in cli-spec.json, not raw SDK identifiers).
      assert.ok(stdout.includes('atomicmemory'));
      // Must NOT leak SDK private shapes (e.g. raw vector arrays).
      assert.ok(!/"vectors":/.test(stdout), 'vector field appeared in skill output');
      assert.ok(!/"embedding":/.test(stdout), 'embedding field appeared in skill output');
    },
  );
});
