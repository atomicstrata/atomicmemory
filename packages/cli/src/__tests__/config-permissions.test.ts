/**
 * @file Config-permissions tests. Verifies dir 0700, file 0600, and the
 * umask-resilient post-mkdir chmod.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  ensureConfigDir,
  readMode,
  tightenConfigFile,
} from '../config/permissions.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'atomicmem-config-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ensureConfigDir creates a missing dir at 0700 even under permissive umask', () => {
  withTempDir((root) => {
    const previousUmask = process.umask(0o000);
    try {
      const target = join(root, 'newchild');
      ensureConfigDir(target);
      assert.ok(existsSync(target));
      assert.equal(readMode(target), CONFIG_DIR_MODE);
    } finally {
      process.umask(previousUmask);
    }
  });
});

test('ensureConfigDir tightens an existing too-permissive dir to 0700', () => {
  withTempDir((root) => {
    const target = join(root, 'wide-open');
    mkdirSync(target, { mode: 0o755 });
    assert.equal(readMode(target), 0o755);
    ensureConfigDir(target);
    assert.equal(readMode(target), CONFIG_DIR_MODE);
  });
});

test('ensureConfigDir refuses to treat a regular file as a config dir', () => {
  withTempDir((root) => {
    const target = join(root, 'not-a-dir');
    writeFileSync(target, 'data');
    assert.throws(
      () => ensureConfigDir(target),
      /not a directory/,
    );
  });
});

test('tightenConfigFile chmods to 0600 when the file exists; no-op otherwise', () => {
  withTempDir((root) => {
    const file = join(root, 'cfg.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    assert.notEqual(readMode(file), CONFIG_FILE_MODE);
    tightenConfigFile(file);
    assert.equal(readMode(file), CONFIG_FILE_MODE);

    const missing = join(root, 'missing.json');
    tightenConfigFile(missing);
    assert.equal(readMode(missing), null);
  });
});
