/**
 * @file Profile-resolution tests for v5's fail-closed provider config
 * rules. Env/flag-only provider setup must not invent trustSurface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBaseProfile } from '../cli/profile-resolution.js';
import type { CliConfigShape } from '../config/schema.js';
import { CliError } from '../types.js';

const emptyConfig: CliConfigShape = {
  schema_version: '2',
  activeProfile: 'default',
  profiles: {},
};

test('env/flag-only profile requires an explicit trust surface', () => {
  assert.throws(
    () =>
      resolveBaseProfile(
        { provider: 'atomicmemory', 'api-url': 'https://core.example.invalid' },
        emptyConfig,
        'default',
        {},
      ),
    (e: unknown) => e instanceof CliError && e.code === 'missing_input',
  );
});

test('env/flag-only profile accepts ATOMICMEMORY_TRUST_SURFACE', () => {
  const profile = resolveBaseProfile(
    { provider: 'atomicmemory', 'api-url': 'https://core.example.invalid' },
    emptyConfig,
    'default',
    { ATOMICMEMORY_TRUST_SURFACE: 'authenticated-wrapper' },
  );
  assert.equal(profile?.trustSurface, 'authenticated-wrapper');
});

test('persisted profile keeps its saved trust surface', () => {
  const profile = resolveBaseProfile(
    {},
    {
      schema_version: '2',
      activeProfile: 'default',
      profiles: {
        default: {
          provider: 'atomicmemory',
          apiUrl: 'http://127.0.0.1:17350',
          trustSurface: 'local',
        },
      },
    },
    'default',
    {},
  );
  assert.equal(profile?.trustSurface, 'local');
});
