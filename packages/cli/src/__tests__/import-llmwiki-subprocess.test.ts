/**
 * @file Subprocess coverage for `atomicmemory import --type llmwiki`.
 *
 * Drives the real built CLI binary via spawnSync — exercising
 * cli-spec.json parse, commander dispatch, flag normalization,
 * handler invocation, and envelope rendering as one chain. The
 * in-process unit tests cover handler logic; this file proves the
 * wiring.
 *
 * Skips when `dist/bin.js` is not built; CI must build before running.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');
const binPath = resolve(cliRoot, 'dist', 'bin.js');
// Single source of truth lives in the llmwiki package; see comment in
// import-llmwiki.test.ts for the rationale.
const fixture = resolve(here, '..', '..', '..', 'llmwiki', 'test-fixtures', 'demo-kb-export.json');

// These tests are release-confidence: they prove the built CLI binary
// dispatches `import --type llmwiki` correctly. Skipping when the
// binary is missing silently no-ops the only end-to-end verification.
// Fail loudly instead so CI lanes that forget the build step surface
// the problem rather than masking it.
function assertBinaryBuilt(): void {
  assert.ok(
    existsSync(binPath),
    `subprocess test requires the CLI build artifact at ${binPath}; ` +
      'run `pnpm --filter @atomicmemory/cli build` before tests.',
  );
}

function runBin(args: readonly string[]): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? -1 };
}

test(
  'subprocess: --type llmwiki --dry-run emits the dryRunPages envelope with exit 0',
  () => {
    assertBinaryBuilt();
    const r = runBin([
      'import',
      '--type',
      'llmwiki',
      fixture,
      '--dry-run',
      '--user',
      'subprocess-test',
      '--json',
    ]);
    assert.equal(r.code, 0, `unexpected stderr: ${r.stderr}`);
    const env = JSON.parse(r.stdout) as {
      command: string;
      data: {
        dryRunPages?: { path: string; externalId: string; bodyBytes: number }[];
        dryRunSummary?: { pageCount: number; projectId: string };
      };
      meta?: { type?: string; dryRun?: boolean };
    };
    assert.equal(env.command, 'import');
    assert.equal(env.meta?.type, 'llmwiki');
    assert.equal(env.meta?.dryRun, true);
    const paths = env.data.dryRunPages?.map((p) => p.path).sort();
    assert.deepEqual(paths, [
      'wiki/concepts/chunking.md',
      'wiki/concepts/retrieval.md',
      'wiki/queries/what-is-retrieval.md',
    ]);
    assert.equal(env.data.dryRunSummary?.pageCount, 3);
    assert.equal(env.data.dryRunSummary?.projectId, 'demo-kb');
  },
);

test(
  'subprocess: --type wrongvalue exits non-zero with a --type-mentioning error',
  () => {
    assertBinaryBuilt();
    const r = runBin([
      'import',
      '--type',
      'wrongvalue',
      fixture,
      '--user',
      'subprocess-test',
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /--type/);
  },
);

test(
  'subprocess: --type llmwiki rejects an export with an invalid projectId',
  () => {
    assertBinaryBuilt();
    const r = runBin([
      'import',
      '--type',
      'llmwiki',
      fixture,
      '--project-id',
      '../escape',
      '--dry-run',
      '--user',
      'subprocess-test',
    ]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /E_LLMWIKI_PROJECT_ID_INVALID/);
  },
);
