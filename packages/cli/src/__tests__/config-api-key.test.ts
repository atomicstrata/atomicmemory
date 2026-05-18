/**
 * @file API-key handling tests:
 *   - plain --api-key flag rejected at parse time (secrets-in-history rule)
 *   - resolveApiKey: env > stdin > profile precedence
 *   - shouldPersistInitKey: persist iff interactive consent OR
 *     (init --api-key-stdin --save-api-key); otherwise the stdin key is
 *     consumed for one-shot validation and discarded
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectPlainApiKeyFlag,
  resolveApiKey,
  shouldPersistInitKey,
} from '../config/api-key.js';
import { CliError } from '../types.js';

test('rejectPlainApiKeyFlag: bare --api-key is rejected with usage exit 2', () => {
  assert.throws(
    () => rejectPlainApiKeyFlag(['add', '--api-key', 'sk-x']),
    (e: unknown) =>
      e instanceof CliError && e.code === 'usage' && e.exitCode === 2,
  );
});

test('rejectPlainApiKeyFlag: --api-key= form is also rejected', () => {
  assert.throws(
    () => rejectPlainApiKeyFlag(['add', '--api-key=sk-x']),
    (e: unknown) => e instanceof CliError && e.code === 'usage',
  );
});

test('rejectPlainApiKeyFlag: --api-key-stdin is allowed and does NOT trip the rejection', () => {
  // No throw.
  rejectPlainApiKeyFlag(['init', '--api-key-stdin', '--save-api-key']);
});

test('resolveApiKey: env wins over stdin and profile', () => {
  assert.equal(
    resolveApiKey({
      envApiKey: 'env-key',
      stdinApiKey: 'stdin-key',
      profileApiKey: 'profile-key',
    }),
    'env-key',
  );
});

test('resolveApiKey: stdin wins over profile when env is absent', () => {
  assert.equal(
    resolveApiKey({ stdinApiKey: 'stdin-key', profileApiKey: 'profile-key' }),
    'stdin-key',
  );
});

test('resolveApiKey: profile is the lowest-precedence source', () => {
  assert.equal(resolveApiKey({ profileApiKey: 'profile-key' }), 'profile-key');
});

test('resolveApiKey: whitespace-only sources are ignored, falling through', () => {
  assert.equal(
    resolveApiKey({
      envApiKey: '   ',
      stdinApiKey: 'stdin-key',
    }),
    'stdin-key',
  );
});

test('resolveApiKey: returns undefined when no source has a real value', () => {
  assert.equal(resolveApiKey({}), undefined);
  assert.equal(resolveApiKey({ envApiKey: '', stdinApiKey: '   ' }), undefined);
});

test('shouldPersistInitKey: interactive consent persists', () => {
  assert.equal(
    shouldPersistInitKey({ hasStdinKey: false, saveApiKey: false, interactiveConsent: true }),
    true,
  );
});

test('shouldPersistInitKey: --api-key-stdin without --save-api-key does NOT persist', () => {
  assert.equal(
    shouldPersistInitKey({ hasStdinKey: true, saveApiKey: false }),
    false,
  );
});

test('shouldPersistInitKey: --api-key-stdin AND --save-api-key persists', () => {
  assert.equal(
    shouldPersistInitKey({ hasStdinKey: true, saveApiKey: true }),
    true,
  );
});

test('shouldPersistInitKey: --save-api-key alone (no stdin source) does NOT persist', () => {
  assert.equal(
    shouldPersistInitKey({ hasStdinKey: false, saveApiKey: true }),
    false,
  );
});

test('shouldPersistInitKey: explicit interactiveConsent=false defers to the flag rules', () => {
  assert.equal(
    shouldPersistInitKey({
      hasStdinKey: true,
      saveApiKey: true,
      interactiveConsent: false,
    }),
    true,
  );
  assert.equal(
    shouldPersistInitKey({
      hasStdinKey: true,
      saveApiKey: false,
      interactiveConsent: false,
    }),
    false,
  );
});
