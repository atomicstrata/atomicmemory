/**
 * @file Subprocess smoke tests for machine-output guarantees that
 * touch the renderer boundary AND the SDK module-load path.
 *
 * Two clusters live here:
 *
 *  - Audit-7 Task A: top-level parse-error mode detection must honor
 *    every machine-mode form, including split `--output json` and
 *    `--output quiet`. Before the fix, both fell through to the human
 *    text renderer on stderr, breaking JSON-only callers.
 *
 *  - Audit-7 Task C: provider-touching machine output must emit one
 *    parseable envelope with no SDK preamble. These tests fail on a
 *    pre-fix SDK because `transformers-env-config.ts` writes
 *    `[TRANSFORMERS-ENV]` to stdout at module load. They pass once the
 *    SDK routes that diagnostic through `debugLog` (no-op by default).
 *
 * Split out from subprocess-smoke.test.ts to keep both files under the
 * 400-line workspace cap. The `runBin` helper is duplicated here on
 * purpose — extracting a shared helper would be a broader refactor
 * than this corrective patch warrants.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const binPath = resolve(cliRoot, 'dist', 'bin.js');

function runBin(args: readonly string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status ?? -1,
  };
}

const skipIfUnbuilt = !existsSync(binPath);

// ---------------------------------------------------------------------------
// Audit-7 Task A: parse-error mode detection
// ---------------------------------------------------------------------------

test('subprocess: --output json parse error -> JSON envelope on stderr, empty stdout', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--output', 'json', 'version', 'extra']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '', `expected empty stdout; got: ${JSON.stringify(r.stdout)}`);
  const lines = r.stderr.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected one envelope on stderr; got: ${r.stderr}`);
  const env = JSON.parse(lines[0]!) as {
    status: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.error.code, 'usage');
});

test('subprocess: --output=json parse error (joined form) -> JSON envelope on stderr, empty stdout', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--output=json', 'version', 'extra']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  const env = JSON.parse(r.stderr.trim()) as {
    status: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.error.code, 'usage');
});

test('subprocess: --output quiet parse error -> empty stdout AND empty stderr, exit 2', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--output', 'quiet', 'version', 'extra']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '', `expected empty stdout; got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.stderr, '', `expected empty stderr; got: ${JSON.stringify(r.stderr)}`);
});

test('subprocess: --output=quiet parse error (joined form) -> empty stdout AND empty stderr, exit 2', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--output=quiet', 'version', 'extra']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

// ---------------------------------------------------------------------------
// Audit-7 Task C: provider-touching machine output (SDK preamble gate)
// ---------------------------------------------------------------------------

test('subprocess: --agent search against unreachable provider -> exactly one JSON envelope on stdout, empty stderr', { skip: skipIfUnbuilt }, () => {
  const r = runBin([
    '--agent',
    'search',
    'q',
    '--user',
    'u',
    '--provider',
    'atomicmemory',
    '--api-url',
    'http://127.0.0.1:9',
  ]);
  assert.notEqual(r.code, 0);
  assert.equal(r.stderr, '', `expected empty stderr; got: ${JSON.stringify(r.stderr)}`);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(
    lines.length,
    1,
    `expected exactly one JSON envelope on stdout; got ${lines.length} lines:\n${r.stdout}`,
  );
  // Specifically forbid the SDK preamble.
  assert.equal(
    /\[TRANSFORMERS-ENV\]/.test(r.stdout),
    false,
    `SDK preamble leaked into --agent stdout: ${r.stdout}`,
  );
  const env = JSON.parse(lines[0]!) as {
    status: string;
    command: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.command, 'search');
});

test('subprocess: --json search against unreachable provider -> stdout empty, stderr exactly one JSON envelope', { skip: skipIfUnbuilt }, () => {
  const r = runBin([
    '--json',
    'search',
    'q',
    '--user',
    'u',
    '--provider',
    'atomicmemory',
    '--api-url',
    'http://127.0.0.1:9',
  ]);
  assert.notEqual(r.code, 0);
  assert.equal(
    r.stdout,
    '',
    `expected empty stdout; got: ${JSON.stringify(r.stdout)}`,
  );
  assert.equal(
    /\[TRANSFORMERS-ENV\]/.test(r.stdout),
    false,
    `SDK preamble leaked into --json stdout: ${r.stdout}`,
  );
  const lines = r.stderr.split('\n').filter((l) => l.length > 0);
  assert.equal(
    lines.length,
    1,
    `expected exactly one JSON envelope on stderr; got ${lines.length} lines:\n${r.stderr}`,
  );
  const env = JSON.parse(lines[0]!) as {
    status: string;
    command: string;
    error: { code: string };
  };
  assert.equal(env.status, 'error');
  assert.equal(env.command, 'search');
});
