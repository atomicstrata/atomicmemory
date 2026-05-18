/**
 * @file Installed-binary diagnostics subprocess tests. These exercise
 * `doctor` and `validate` through the built `dist/bin.js` entrypoint so
 * the v5 diagnostic contract is covered outside direct handler tests.
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
const skipIfUnbuilt = !existsSync(binPath);

function runBin(args: readonly string[]): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

test('subprocess: doctor --json --quick --offline emits diagnostics without provider connectivity', { skip: skipIfUnbuilt }, () => {
  const result = runBin(['--json', 'doctor', '--quick', '--offline']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout.trim()) as {
    command: string;
    data: { mode: string; checks: Array<{ id: string }> };
  };
  assert.equal(envelope.command, 'doctor');
  assert.equal(envelope.data.mode, 'offline');
  const ids = envelope.data.checks.map((check) => check.id);
  assert.ok(ids.includes('mcp.coexistence'));
  assert.equal(ids.includes('provider.connectivity'), false);
});

test('subprocess: validate --json emits installed-package check IDs', { skip: skipIfUnbuilt }, () => {
  const result = runBin(['--json', 'validate']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout.trim()) as {
    command: string;
    data: { checks: Array<{ id: string; ok: boolean }> };
  };
  assert.equal(envelope.command, 'validate');
  const ids = envelope.data.checks.map((check) => check.id);
  for (const id of [
    'command_spec.examples',
    'output_envelope.shape',
    'secret.redaction_behavior',
  ]) {
    assert.ok(ids.includes(id), `missing validate check ${id}`);
  }
});
