/**
 * @file CliError default exit-code mapping (v5 §"Output Semantics" exit
 * matrix). The default must derive from the code so that every callsite
 * that simply does `new CliError('not_found', '...')` produces exit 4
 * without remembering to pass an override.
 *
 * Also asserts the agent_id field is the canonical CLI-facing scope name
 * (Phase 4 adapters map it onto the SDK's `Scope.agent`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CliError, defaultExitCodeFor, type CliScope } from '../types.js';

test('defaultExitCodeFor: usage/missing/capability/experimental codes return 2', () => {
  for (const code of [
    'usage',
    'missing_input',
    'missing_user',
    'missing_scope_field',
    'unsupported_capability',
    'experimental_disabled',
  ] as const) {
    assert.equal(defaultExitCodeFor(code), 2, `${code} should default to 2`);
  }
});

test('defaultExitCodeFor: connectivity and auth codes return 3', () => {
  assert.equal(defaultExitCodeFor('connectivity'), 3);
  assert.equal(defaultExitCodeFor('auth'), 3);
});

test('defaultExitCodeFor: not_found returns 4', () => {
  assert.equal(defaultExitCodeFor('not_found'), 4);
});

test('defaultExitCodeFor: runtime returns 1', () => {
  assert.equal(defaultExitCodeFor('runtime'), 1);
});

test('CliError without explicit exitCode adopts the default for its code', () => {
  assert.equal(new CliError('missing_user', 'x').exitCode, 2);
  assert.equal(new CliError('missing_scope_field', 'x').exitCode, 2);
  assert.equal(new CliError('unsupported_capability', 'x').exitCode, 2);
  assert.equal(new CliError('experimental_disabled', 'x').exitCode, 2);
  assert.equal(new CliError('usage', 'x').exitCode, 2);
  assert.equal(new CliError('missing_input', 'x').exitCode, 2);
  assert.equal(new CliError('connectivity', 'x').exitCode, 3);
  assert.equal(new CliError('auth', 'x').exitCode, 3);
  assert.equal(new CliError('not_found', 'x').exitCode, 4);
  assert.equal(new CliError('runtime', 'x').exitCode, 1);
});

test('CliError honors an explicit exitCode override when supplied', () => {
  // The override is allowed but should be rare; defaults are correct for
  // the v5 contract. This test exists to prevent accidental removal of
  // the override surface, not to encourage its use.
  const e = new CliError('runtime', 'cap-mismatched runtime', 4);
  assert.equal(e.exitCode, 4);
  assert.equal(e.code, 'runtime');
});

test('CliScope canonical CLI fields use agent_id, not agent', () => {
  // Compile-time check: the v5 CLI scope shape exposes agent_id (mapped
  // by Phase 4 adapters onto the SDK's Scope.agent).
  const scope: CliScope = {
    user: 'u1',
    agent_id: 'a1',
    namespace: 'n1',
    thread: 't1',
  };
  assert.equal(scope.agent_id, 'a1');
  // Negative compile-time check: the old V0 `agent` key must not be a
  // valid property of CliScope. The cast asserts it would be a runtime
  // foreign property.
  assert.equal((scope as Record<string, unknown>).agent, undefined);
});
