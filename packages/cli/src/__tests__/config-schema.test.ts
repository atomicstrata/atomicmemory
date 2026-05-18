/**
 * @file Zod schema tests: shape, strictness, canonical agent_id field,
 * schema_version literal "2".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CliConfigSchema,
  CliProfileSchema,
  CliScopePartialSchema,
  emptyConfig,
  PROVIDERS,
  SCHEMA_VERSION,
} from '../config/schema.js';

test('schema_version literal is the single source of truth', () => {
  assert.equal(SCHEMA_VERSION, '2');
  assert.equal(emptyConfig().schema_version, '2');
});

test('canonical scope uses agent_id, not the V0 agent alias', () => {
  const ok = CliScopePartialSchema.safeParse({ user: 'u1', agent_id: 'a1' });
  assert.equal(ok.success, true);
  // Strict shape: V0's `agent` key is rejected.
  const fail = CliScopePartialSchema.safeParse({ user: 'u1', agent: 'a1' });
  assert.equal(fail.success, false);
});

test('CliProfileSchema accepts a fully populated profile', () => {
  const ok = CliProfileSchema.safeParse({
    provider: 'atomicmemory',
    apiUrl: 'http://localhost:3000',
    trustSurface: 'local',
    scope: { user: 'u1', agent_id: 'a1', namespace: 'n', thread: 't' },
    output: 'agent',
    apiKey: 'sk-x',
  });
  assert.equal(ok.success, true, JSON.stringify(ok));
});

test('CliProfileSchema rejects unknown providers, urls, trust surfaces, output modes', () => {
  for (const bad of [
    { provider: 'nope', apiUrl: 'http://x', trustSurface: 'local' },
    { provider: 'atomicmemory', apiUrl: 'not-a-url', trustSurface: 'local' },
    { provider: 'atomicmemory', apiUrl: 'http://x', trustSurface: 'cloud' },
    {
      provider: 'atomicmemory',
      apiUrl: 'http://x',
      trustSurface: 'local',
      output: 'csv',
    },
  ] as const) {
    const r = CliProfileSchema.safeParse(bad);
    assert.equal(r.success, false, `expected reject for ${JSON.stringify(bad)}`);
  }
});

test('CliProfileSchema rejects unknown top-level keys (strict)', () => {
  const r = CliProfileSchema.safeParse({
    provider: 'atomicmemory',
    apiUrl: 'http://x',
    trustSurface: 'local',
    extra: 'nope',
  });
  assert.equal(r.success, false);
});

test('CliConfigSchema enforces schema_version "2" and at least one profile name', () => {
  const ok = CliConfigSchema.safeParse({
    schema_version: '2',
    activeProfile: 'default',
    profiles: {
      default: {
        provider: 'atomicmemory',
        apiUrl: 'http://localhost:3000',
        trustSurface: 'local',
      },
    },
  });
  assert.equal(ok.success, true);

  for (const bad of [
    { schema_version: '1', activeProfile: 'default', profiles: {} },
    { schema_version: '2', activeProfile: '', profiles: {} },
  ] as const) {
    const r = CliConfigSchema.safeParse(bad);
    assert.equal(r.success, false, `expected reject for ${JSON.stringify(bad)}`);
  }
});

test('emptyConfig returns a fresh empty default-named config', () => {
  const c = emptyConfig();
  assert.equal(c.schema_version, '2');
  assert.equal(c.activeProfile, 'default');
  assert.deepEqual(c.profiles, {});
});

test('PROVIDERS list matches v5 spec (atomicmemory + mem0 only)', () => {
  assert.deepEqual([...PROVIDERS].sort(), ['atomicmemory', 'mem0']);
});
