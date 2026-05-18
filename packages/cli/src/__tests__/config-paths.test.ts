/**
 * @file Config-path resolution tests. Covers default location, env
 * override, and `--config` flag override.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveConfigPaths } from '../config/paths.js';

test('default paths land in ~/.atomicmemory/config.json', () => {
  const { dir, file } = resolveConfigPaths({ env: {} });
  assert.equal(dir, join(homedir(), '.atomicmemory'));
  assert.equal(file, join(homedir(), '.atomicmemory', 'config.json'));
});

test('ATOMICMEMORY_CONFIG env var wins over the default', () => {
  const { dir, file } = resolveConfigPaths({
    env: { ATOMICMEMORY_CONFIG: '/tmp/atomicmem-test/config.json' },
  });
  assert.equal(dir, '/tmp/atomicmem-test');
  assert.equal(file, '/tmp/atomicmem-test/config.json');
});

test('--config flag override wins over env and default', () => {
  const { dir, file } = resolveConfigPaths({
    flagOverride: '/etc/atomicmem/conf.json',
    env: { ATOMICMEMORY_CONFIG: '/tmp/lower-precedence/config.json' },
  });
  assert.equal(dir, '/etc/atomicmem');
  assert.equal(file, '/etc/atomicmem/conf.json');
});

test('whitespace-only overrides are ignored, not treated as a path', () => {
  const { file } = resolveConfigPaths({
    flagOverride: '   ',
    env: { ATOMICMEMORY_CONFIG: '\t\n' },
  });
  assert.equal(file, join(homedir(), '.atomicmemory', 'config.json'));
});
