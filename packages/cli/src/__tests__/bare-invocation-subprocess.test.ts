/**
 * @file Subprocess coverage for bare `atomicmemory` invocations.
 *
 * v5 §"Help and Versioning": no-subcommand invocation must render the
 * compact dashboard for humans (text mode), the spec document JSON for
 * `--json`, and the same document wrapped in the agent envelope for
 * `--agent` — all with exit 0. Before this fix the bare path tripped
 * commander's "missing subcommand" error and surfaced "(outputHelp)"
 * to every output mode, including agent loops.
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

function runBin(args: readonly string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

test('subprocess: bare atomicmemory renders the text dashboard with exit 0', { skip: skipIfUnbuilt }, () => {
  const r = runBin([]);
  assert.equal(r.code, 0);
  assert.equal(/\(outputHelp\)/.test(r.stdout + r.stderr), false);
  // Banner + section labels are stable v5 markers.
  assert.match(r.stdout, /atomicmemory CLI v/);
  assert.match(r.stdout, /getting started/);
  assert.match(r.stdout, /commands/);
});

test('subprocess: bare atomicmemory --json emits one JSON spec document on stdout', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--json']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const env = JSON.parse(lines[0]!) as {
    command: string;
    data: { spec_version: string; commands: Array<{ name: string }> };
  };
  assert.equal(env.command, 'help');
  assert.match(env.data.spec_version, /^5\./);
  assert.ok(env.data.commands.some((c) => c.name === 'init'));
});

test('subprocess: bare atomicmemory --agent emits exactly one agent envelope', { skip: skipIfUnbuilt }, () => {
  const r = runBin(['--agent']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const env = JSON.parse(lines[0]!) as {
    status: string;
    command: string;
    data: { spec_version: string };
  };
  assert.equal(env.status, 'success');
  assert.equal(env.command, 'help');
  assert.match(env.data.spec_version, /^5\./);
});
