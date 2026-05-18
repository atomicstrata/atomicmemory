/**
 * @file Capability gate tests. Covers extensions.* and customExtensions.*
 * paths, ingestModes.* gating, the reranker gate, and the
 * --experimental flag gate (which must precede capability checks for
 * hidden experimental commands).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCapability,
  assertExperimentalEnabled,
  assertReranker,
  hasCapability,
} from '../capability-gate.js';
import { CliError, type ProviderCapabilities } from '../types.js';

const baseCaps: ProviderCapabilities = {
  ingestModes: ['text', 'messages'],
  extensions: { package: false },
};

const atomicmemoryCaps: ProviderCapabilities = {
  ingestModes: ['text', 'messages', 'verbatim'],
  extensions: { package: true, update: true },
  customExtensions: {
    'atomicmemory.lifecycle': { version: '1.0' },
    'atomicmemory.audit': { version: '1.0' },
  },
  supportedRerankers: ['mmr', 'cross-encoder'],
};

test('assertCapability passes when extensions flag is true', () => {
  assertCapability(atomicmemoryCaps, 'extensions.package');
});

test('assertCapability throws unsupported_capability exit 2 when extensions flag is false', () => {
  assert.throws(
    () => assertCapability(baseCaps, 'extensions.package'),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'unsupported_capability' &&
      e.exitCode === 2,
  );
});

test('assertCapability honors customExtensions for experimental commands', () => {
  assertCapability(atomicmemoryCaps, 'customExtensions.atomicmemory.lifecycle');
  assert.throws(
    () =>
      assertCapability(baseCaps, 'customExtensions.atomicmemory.lifecycle'),
    (e: unknown) => e instanceof CliError && e.code === 'unsupported_capability',
  );
});

test('assertCapability gates ingestModes.<mode>', () => {
  assertCapability(atomicmemoryCaps, 'ingestModes.verbatim');
  assert.throws(
    () => assertCapability(baseCaps, 'ingestModes.verbatim'),
    (e: unknown) => e instanceof CliError && e.code === 'unsupported_capability',
  );
});

test('assertCapability includes context in the error message when supplied', () => {
  try {
    assertCapability(baseCaps, 'extensions.package', 'package command');
    assert.fail('expected CliError');
  } catch (e) {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /extensions\.package/);
    assert.match(e.message, /package command/);
  }
});

test('hasCapability returns the boolean equivalent without throwing', () => {
  assert.equal(hasCapability(atomicmemoryCaps, 'extensions.package'), true);
  assert.equal(hasCapability(baseCaps, 'extensions.package'), false);
  assert.equal(
    hasCapability(atomicmemoryCaps, 'customExtensions.atomicmemory.lifecycle'),
    true,
  );
  assert.equal(
    hasCapability(baseCaps, 'customExtensions.atomicmemory.lifecycle'),
    false,
  );
  assert.equal(hasCapability(atomicmemoryCaps, 'ingestModes.verbatim'), true);
  assert.equal(hasCapability(baseCaps, 'ingestModes.verbatim'), false);
});

test('assertReranker passes when the name appears in supportedRerankers', () => {
  assertReranker(atomicmemoryCaps, 'mmr');
  assertReranker(atomicmemoryCaps, 'cross-encoder');
});

test('assertReranker throws unsupported_capability and lists available names', () => {
  try {
    assertReranker(atomicmemoryCaps, 'mystery');
    assert.fail('expected CliError');
  } catch (e) {
    assert.ok(e instanceof CliError);
    assert.equal(e.code, 'unsupported_capability');
    assert.match(e.message, /mmr/);
    assert.match(e.message, /cross-encoder/);
  }
});

test('assertReranker reports "(none)" when supportedRerankers is empty/absent', () => {
  try {
    assertReranker(baseCaps, 'mmr');
    assert.fail('expected CliError');
  } catch (e) {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /\(none\)/);
  }
});

test('assertExperimentalEnabled passes when --experimental was set', () => {
  assertExperimentalEnabled({ experimental: true });
});

test('assertExperimentalEnabled throws experimental_disabled exit 2 otherwise', () => {
  for (const flags of [{}, { experimental: false }] as const) {
    assert.throws(
      () => assertExperimentalEnabled(flags),
      (e: unknown) =>
        e instanceof CliError &&
        e.code === 'experimental_disabled' &&
        e.exitCode === 2,
    );
  }
});
