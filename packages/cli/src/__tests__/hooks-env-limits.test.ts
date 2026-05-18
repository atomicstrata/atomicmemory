/**
 * @file `readPositiveIntEnv` fail-closed coverage for the hook char-limit
 * env vars (`ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS`,
 * `ATOMICMEMORY_STOP_MAX_SUMMARY_CHARS`,
 * `ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS`). v5 forbids silent fallbacks:
 * an invalid env value MUST surface a `usage` CliError before any
 * provider/adapter init runs, not be swallowed and replaced with the
 * compiled-in default.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hooks } from '../commands/setup/hooks/index.js';
import { CliError } from '../types.js';
import {
  COMPACT_MAX_SUMMARY_ENV,
  STOP_MIN_ASSISTANT_ENV,
  readPositiveIntEnv,
} from '../commands/setup/hooks/types.js';
import type { CommandContext } from '../commands/types.js';

function ctx(overrides: Partial<CommandContext>): CommandContext {
  return {
    command: 'hooks',
    positional: ['run', 'stop'],
    flags: {},
    config: { schema_version: '2', activeProfile: 'default', profiles: {} },
    configPath: '/tmp/atomicmemory/config.json',
    configDir: '/tmp/atomicmemory',
    profile: null,
    scope: { user: 'u1' },
    env: {},
    version: '0.1.0',
    readStdin: async () => '',
    experimental: false,
    getAdapter: async () => {
      throw new Error('env validation must fail before adapter init');
    },
    ...overrides,
  };
}

test('readPositiveIntEnv accepts undefined / empty string and returns the fallback', () => {
  assert.equal(readPositiveIntEnv({}, 'X', 42), 42);
  assert.equal(readPositiveIntEnv({ X: '' }, 'X', 42), 42);
});

test('readPositiveIntEnv accepts a positive integer string', () => {
  assert.equal(readPositiveIntEnv({ X: '7' }, 'X', 42), 7);
  assert.equal(readPositiveIntEnv({ X: '1000' }, 'X', 42), 1000);
});

test('readPositiveIntEnv rejects non-numeric values with usage error', () => {
  assert.throws(
    () => readPositiveIntEnv({ X: 'abc' }, 'X', 42),
    (err) => err instanceof CliError && err.code === 'usage' && /X/.test(err.message),
  );
});

test('readPositiveIntEnv rejects zero with usage error', () => {
  // Zero is not a positive integer. Silently treating it as the
  // default would be a fallback and is forbidden.
  assert.throws(
    () => readPositiveIntEnv({ X: '0' }, 'X', 42),
    (err) => err instanceof CliError && err.code === 'usage',
  );
});

test('readPositiveIntEnv rejects negative integers and floats', () => {
  for (const bad of ['-1', '1.5', ' 5 ', '5x']) {
    assert.throws(
      () => readPositiveIntEnv({ X: bad }, 'X', 42),
      (err) => err instanceof CliError && err.code === 'usage',
      `expected ${bad} to fail`,
    );
  }
});

test('hooks run stop fails closed before adapter init when ATOMICMEMORY_STOP_MIN_ASSISTANT_CHARS is invalid', async () => {
  await assert.rejects(
    hooks(ctx({
      env: { [STOP_MIN_ASSISTANT_ENV]: 'lots' },
      readStdin: async () => JSON.stringify({
        assistant_response:
          'A long enough response that would normally pass the default low-signal '
          + 'gate so we know the failure is the env validator, not the length check.',
      }),
    })),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      err.message.includes(STOP_MIN_ASSISTANT_ENV),
  );
});

test('hooks run post-compact fails closed before adapter init when ATOMICMEMORY_COMPACT_MAX_SUMMARY_CHARS is invalid', async () => {
  await assert.rejects(
    hooks(ctx({
      positional: ['run', 'post-compact'],
      env: { [COMPACT_MAX_SUMMARY_ENV]: '0' },
      readStdin: async () => JSON.stringify({
        compact_summary: 'Real compact summary content the cap would otherwise truncate.',
      }),
    })),
    (err) =>
      err instanceof CliError &&
      err.code === 'usage' &&
      err.message.includes(COMPACT_MAX_SUMMARY_ENV),
  );
});
