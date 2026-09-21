/**
 * Unit tests for the lean Deno-compile staging helper.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEAN_DROP_DEPENDENCIES,
  buildLeanPackage,
  lockVersionsFromPnpmList,
  pinExactVersions,
  pruneDeployedTree,
  verifyStagingVersions,
  writePinnedLeanPackageFile,
} from '../lib/write-lean-staging-package.mjs';

describe('write-lean-staging-package', () => {
  it('drops the lean-profile packages from dependencies', () => {
    const lean = buildLeanPackage({
      name: '@atomicmemory/core',
      version: '1.2.1',
      dependencies: {
        express: '5.1.0',
        '@huggingface/transformers': '3.8.1',
        viem: '2.0.0',
        tsx: '4.0.0',
      },
    });
    assert.deepEqual(Object.keys(lean.dependencies), ['express']);
    for (const name of LEAN_DROP_DEPENDENCIES) {
      assert.equal(lean.dependencies[name], undefined);
    }
  });

  it('pins kept dependencies to exact lockfile versions', () => {
    const staging = mkdtempSync(join(tmpdir(), 'am-lean-pin-'));
    try {
      const srcPath = join(staging, 'source.json');
      const lockPath = join(staging, 'lock.json');
      const destPath = join(staging, 'package.json');
      writeFileSync(srcPath, JSON.stringify({
        name: '@atomicmemory/core',
        version: '1.2.1',
        dependencies: { express: '^5.1.0', viem: '^2.0.0' },
      }));
      writeFileSync(lockPath, JSON.stringify({
        dependencies: {
          express: { version: '5.1.0(zod@4.0.0)' },
          viem: { version: '2.0.0' },
        },
      }));
      const lean = writePinnedLeanPackageFile(srcPath, lockPath, destPath);
      assert.deepEqual(lean.dependencies, { express: '5.1.0' });
      assert.deepEqual(
        pinExactVersions({ dependencies: { express: '^5.1.0' } }, { express: '5.1.0' }).dependencies,
        { express: '5.1.0' },
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('fails closed when a kept dependency has no lock version', () => {
    assert.throws(
      () => pinExactVersions({ dependencies: { express: '^5.1.0' } }, {}),
      /missing lockfile version for express/,
    );
  });

  it('prunes dropped node_modules and verifies lock versions', () => {
    const staging = mkdtempSync(join(tmpdir(), 'am-lean-'));
    try {
      mkdirSync(join(staging, 'node_modules', 'express'), { recursive: true });
      mkdirSync(join(staging, 'node_modules', 'viem'), { recursive: true });
      writeFileSync(join(staging, 'package.json'), JSON.stringify({
        name: '@atomicmemory/core',
        version: '1.2.1',
        dependencies: { express: '^5.1.0', viem: '^2.0.0' },
      }));
      writeFileSync(join(staging, 'node_modules', 'express', 'package.json'), '{"version":"5.1.0"}\n');
      writeFileSync(join(staging, 'node_modules', 'viem', 'package.json'), '{"version":"2.0.0"}\n');
      pruneDeployedTree(staging);
      const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies.viem, undefined);
      const versions = lockVersionsFromPnpmList({ dependencies: { express: { version: '5.1.0' } } });
      verifyStagingVersions(staging, versions);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
