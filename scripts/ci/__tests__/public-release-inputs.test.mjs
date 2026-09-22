/** Verify mirrored workflows consume private inputs without private source files. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parse } from 'yaml';

const workflow = (name) => parse(readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const secretExpression = '${{ secrets.PUBLIC_ARTIFACT_SIGNATURES }}';
const packages = workflow('publish-packages');
const docker = workflow('publish-core-docker');

test('Docker publisher reads npm dotted-key tarball metadata and rejects missing values', () => {
  const step = docker.jobs.publish.steps.find((s) => s.id === 'package');
  const dir = mkdtempSync(join(tmpdir(), 'am-release-metadata-'));
  try {
    const output = join(dir, 'output');
    const marker = join(dir, 'docker-called');
    const tarball = 'https://registry.npmjs.org/@atomicmemory/core/-/core-1.2.2.tgz';
    const stubs = 'npm() { if [[ "$*" == *"--json"* ]]; then printf "%s" "$METADATA"; else echo 1.2.2; fi; }; docker() { touch "$DOCKER_MARKER"; return 1; };\n';
    const run = (value) => {
      writeFileSync(output, '');
      rmSync(marker, { force: true });
      return spawnSync('bash', ['-c', stubs + step.run], { encoding: 'utf8', env: {
        ...process.env, CORE_VERSION_INPUT: '1.2.2', IMAGE_NAME: 'fixture/core',
        GITHUB_OUTPUT: output, DOCKER_MARKER: marker,
        METADATA: JSON.stringify({ version: '1.2.2', gitHead: 'a'.repeat(40), 'dist.tarball': value }),
      } });
    };
    const success = run(tarball);
    assert.equal(success.status, 0, success.stderr);
    assert.ok(readFileSync(output, 'utf8').split('\n').includes(`tarball=${tarball}`));
    for (const value of [undefined, null, '', 42, {}]) {
      const failure = run(value);
      assert.notEqual(failure.status, 0);
      assert.match(failure.stdout, /missing dist\.tarball/);
      assert.equal(readFileSync(output, 'utf8'), '');
      assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted tests run only in the internal repository', () => {
  const step = workflow('ci').jobs['affected-build-test'].steps.find((s) => s.run?.includes('hosted/__tests__/run.sh'));
  assert.equal(step.if, "github.repository == 'atomicstrata/atomicmemory-internal'");
});

test('reusable Docker publisher receives the required signature secret', () => {
  assert.equal(docker.on.workflow_call.secrets.PUBLIC_ARTIFACT_SIGNATURES.required, true);
  assert.equal(packages.jobs['publish-core-docker'].secrets.PUBLIC_ARTIFACT_SIGNATURES, secretExpression);
});

// Run the actual workflow shell blocks in a source fixture with no hosted/ tree.
// Stubs replace only network/build operations; the signature handoff is real.
for (const [name, steps, prefix] of [
  ['packages', packages.jobs.preflight.steps, ''],
  ['docker', docker.jobs.publish.steps, 'release-source/'],
]) {
  const step = steps.find((s) => s.name.includes('private identifiers'));
  test(`${name}: installs ripgrep before scanning artifacts`, () => {
    const setup = steps.find((s) => s.name === 'Install artifact scanner dependency');
    assert.ok(setup);
    assert.ok(steps.indexOf(setup) < steps.indexOf(step));
    assert.equal(setup.if, undefined);
    const commands = [];
    const result = spawnSync('bash', ['-e', '-c',
      'sudo() { printf "%s\\n" "$*"; }; rg() { printf "rg %s\\n" "$*"; };\n' + setup.run],
    { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    commands.push(...result.stdout.trim().split('\n'));
    assert.deepEqual(commands, [
      'apt-get update',
      'apt-get install --yes --no-install-recommends ripgrep',
      'rg --version',
    ]);
  });
  test(`${name}: secret reaches scanner, missing secret refuses release`, () => {
    assert.equal(step.env.PUBLIC_ARTIFACT_SIGNATURES, secretExpression);
    const dir = mkdtempSync(join(tmpdir(), 'am-release-input-'));
    try {
      const scripts = join(dir, prefix, 'packages/core/scripts');
      mkdirSync(scripts, { recursive: true });
      writeFileSync(join(scripts, 'check-public-artifacts.sh'), '#!/bin/bash\nset -eu\ncmp "$3" "$EXPECTED_SIGNATURES"\nprintf reached > "$RUNNER_TEMP/scanned"\n', { mode: 0o755 });
      const expected = join(dir, 'expected');
      writeFileSync(expected, 'synthetic-private-marker\n');
      const stubs = 'npm() { touch "$RUNNER_TEMP/atomicmemory-core-package/test.tgz"; }; docker() { :; }; curl() { :; };\n';
      const env = { ...process.env, RUNNER_TEMP: dir, PACKAGE_TARBALL: 'fixture', IMAGE_REFERENCE: 'fixture', EXPECTED_SIGNATURES: expected };
      const run = (value) => spawnSync('bash', ['-c', stubs + step.run], { cwd: dir, env: { ...env, PUBLIC_ARTIFACT_SIGNATURES: value }, encoding: 'utf8' });
      for (const value of ['synthetic-private-marker', '\nsynthetic-private-marker\n \n']) {
        const success = run(value);
        assert.equal(success.status, 0, success.stderr);
        assert.equal(readFileSync(join(dir, 'scanned'), 'utf8'), 'reached');
        rmSync(join(dir, 'scanned'));
      }
      for (const value of ['', ' \n ']) {
        const failure = run(value);
        assert.equal(failure.status, 64, failure.stderr);
        assert.match(failure.stdout, /must be configured/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
