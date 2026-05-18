/**
 * @file Scope resolution + static/dynamic scope assertion tests.
 *
 * Covers:
 *   - flags > env > profile precedence
 *   - canonical agent_id field end-to-end (no V0 `agent` reintroduced)
 *   - missing_user fires statically before adapter init
 *   - missing_scope_field fires dynamically, with a fallback to
 *     capabilities.requiredScope.default when the operation-specific
 *     entry is absent
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDynamicScope,
  assertStaticScope,
  intoCliScope,
  resolveScope,
} from '../config/resolve.js';
import { CliError, type ProviderCapabilities } from '../types.js';

test('resolveScope: flags win over env, env wins over profile, fall-through is preserved', () => {
  const scope = resolveScope({
    profileScope: { user: 'profile-user', namespace: 'profile-ns' },
    flags: { user: 'flag-user' },
    env: {
      ATOMICMEMORY_SCOPE_USER: 'env-user',
      ATOMICMEMORY_SCOPE_AGENT_ID: 'env-agent',
    },
  });
  // flag wins for user; env supplies agent_id; profile supplies namespace.
  assert.equal(scope.user, 'flag-user');
  assert.equal(scope.agent_id, 'env-agent');
  assert.equal(scope.namespace, 'profile-ns');
});

test('resolveScope: empty/whitespace flag values do not blank out lower precedence layers', () => {
  const scope = resolveScope({
    profileScope: { user: 'profile-user' },
    flags: { user: '   ', agentId: '' },
    env: {},
  });
  assert.equal(scope.user, 'profile-user');
  assert.equal(scope.agent_id, undefined);
});

test('resolveScope: canonical CLI surface is agent_id; flags use the agentId camelCase form', () => {
  const scope = resolveScope({
    flags: { agentId: 'a1' },
    env: {},
  });
  assert.equal(scope.agent_id, 'a1');
  assert.equal((scope as Record<string, unknown>).agent, undefined);
});

test('resolveScope: works without a profile (no synthesized fake)', () => {
  const scope = resolveScope({
    flags: { user: 'flag-user' },
    env: { ATOMICMEMORY_SCOPE_NAMESPACE: 'env-ns' },
  });
  assert.equal(scope.user, 'flag-user');
  assert.equal(scope.namespace, 'env-ns');
});

test('assertStaticScope: missing user throws missing_user with default exit 2', () => {
  assert.throws(
    () => assertStaticScope({}, { requireUser: true }),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'missing_user' &&
      e.exitCode === 2,
  );
});

test('assertStaticScope: passes through when requireUser is false', () => {
  // No throw: this command does not need a user (e.g., bare dashboard).
  assertStaticScope({}, { requireUser: false });
});

test('assertDynamicScope: operation-specific requirement wins when present', () => {
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: true },
    requiredScope: {
      search: ['user', 'namespace'],
      default: ['user'],
    },
  };
  // search requires namespace; missing -> missing_scope_field
  assert.throws(
    () =>
      assertDynamicScope({ user: 'u1' }, 'search', caps),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'missing_scope_field' &&
      e.exitCode === 2,
  );
  // search satisfied
  assertDynamicScope({ user: 'u1', namespace: 'n1' }, 'search', caps);
});

test('assertDynamicScope: falls back to requiredScope.default when operation entry is absent', () => {
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: true },
    requiredScope: {
      default: ['user', 'agent_id'],
    },
  };
  // operation "ingest" has no specific entry; default fires.
  assert.throws(
    () => assertDynamicScope({ user: 'u1' }, 'ingest', caps),
    (e: unknown) =>
      e instanceof CliError &&
      e.code === 'missing_scope_field' &&
      e.exitCode === 2,
  );
  // default satisfied
  assertDynamicScope({ user: 'u1', agent_id: 'a1' }, 'ingest', caps);
});

test('assertDynamicScope: no requiredScope at all is a no-op', () => {
  const caps: ProviderCapabilities = {
    ingestModes: ['text'],
    extensions: { package: true },
  };
  assertDynamicScope({}, 'whatever', caps); // does not throw
});

test('intoCliScope returns canonical CliScope when user is present', () => {
  const out = intoCliScope({
    user: 'u1',
    agent_id: 'a1',
    namespace: 'n',
    thread: 't',
  });
  assert.deepEqual(out, { user: 'u1', agent_id: 'a1', namespace: 'n', thread: 't' });
});

test('intoCliScope without user is a programming error and throws missing_user', () => {
  assert.throws(
    () => intoCliScope({}),
    (e: unknown) => e instanceof CliError && e.code === 'missing_user',
  );
});
