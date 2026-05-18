/**
 * @file Spec loader tests — schema validation, invariants, caching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetSpecCache,
  loadSpec,
  parseSpec,
} from '../spec/loader.js';

test('loadSpec returns a v5 spec with the expected v5 features', () => {
  _resetSpecCache();
  const spec = loadSpec();
  assert.match(spec.spec_version, /^5\./);
  assert.equal(spec.package_name, '@atomicmemory/cli');
  assert.ok(spec.global_options.some((o) => o.name === '--interactive'));
  assert.ok(spec.global_options.some((o) => o.name === '--no-interactive'));
  assert.ok(spec.global_options.some((o) => o.name === '--experimental'));
  assert.ok(spec.commands.some((c) => c.name === 'search'));
  // hidden experimental commands present in spec but marked hidden
  for (const name of ['lifecycle', 'audit', 'lessons', 'agents']) {
    const cmd = spec.commands.find((c) => c.name === name);
    assert.ok(cmd, `${name} should exist in spec`);
    assert.equal(cmd?.hidden, true);
    assert.equal(cmd?.category, 'experimental');
  }
  // runtime is intentionally not in the spec
  assert.ok(!spec.commands.some((c) => c.name === 'runtime'));
});

test('parseSpec rejects spec_version below 5.x', () => {
  assert.throws(
    () =>
      parseSpec({
        spec_version: '4.9.0',
        package_name: 'x',
        package_version: '0.1.0',
        global_options: [{ name: '--json', description: 'x' }],
        commands: [
          {
            name: 'help',
            usage: 'x',
            summary: 'x',
            category: 'diagnostics',
            allowed_outputs: ['text'],
          },
        ],
      }),
    /spec_version must be 5\.x/,
  );
});

test('parseSpec rejects duplicate command names', () => {
  assert.throws(
    () =>
      parseSpec({
        spec_version: '5.0.0',
        package_name: 'x',
        package_version: '0.1.0',
        global_options: [{ name: '--json', description: 'x' }],
        commands: [
          {
            name: 'help',
            usage: 'x',
            summary: 'x',
            category: 'diagnostics',
            allowed_outputs: ['text'],
          },
          {
            name: 'help',
            usage: 'y',
            summary: 'y',
            category: 'diagnostics',
            allowed_outputs: ['text'],
          },
        ],
      }),
    /duplicate top-level command "help"/,
  );
});

test('parseSpec rejects invalid allowed_outputs values', () => {
  assert.throws(() =>
    parseSpec({
      spec_version: '5.0.0',
      package_name: 'x',
      package_version: '0.1.0',
      global_options: [{ name: '--json', description: 'x' }],
      commands: [
        {
          name: 'help',
          usage: 'x',
          summary: 'x',
          category: 'diagnostics',
          allowed_outputs: ['gibberish'],
        },
      ],
    }),
  );
});

test('search command does not advertise --threshold (deferred from V1)', () => {
  _resetSpecCache();
  const spec = loadSpec();
  const search = spec.commands.find((c) => c.name === 'search');
  assert.ok(search);
  assert.ok(!(search?.flags ?? []).some((f) => f.includes('--threshold')));
  assert.ok((search?.flags ?? []).some((f) => f.includes('--filter-json')));
});
