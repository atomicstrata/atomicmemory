/**
 * @file Unit tests for the bounded hosted-session registry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashApiKey } from './auth.js';
import { keyHashMatches, SessionRegistry, type SessionEntry } from './session-registry.js';

const LIMITS = { sessionIdleTtlMs: 1_000, maxSessions: 3, maxSessionsPerKey: 2 };

function entry(key: string): Omit<SessionEntry, 'lastSeenAt'> {
  return {
    transport: {} as SessionEntry['transport'],
    server: {} as SessionEntry['server'],
    keyHash: hashApiKey(key),
  };
}

test('keyHashMatches compares digests of the key', () => {
  assert.equal(keyHashMatches(hashApiKey('amc_a'), hashApiKey('amc_a')), true);
  assert.equal(keyHashMatches(hashApiKey('amc_a'), hashApiKey('amc_b')), false);
  assert.equal(keyHashMatches(hashApiKey('amc_a'), Buffer.alloc(4)), false);
});

test('pending reservations count against the per-key and global caps', () => {
  const registry = new SessionRegistry(LIMITS);
  const a1 = registry.reserve(hashApiKey('amc_a'));
  const a2 = registry.reserve(hashApiKey('amc_a'));
  assert.equal(typeof a1, 'object');
  assert.equal(typeof a2, 'object');
  assert.equal(registry.reserve(hashApiKey('amc_a')), 'key_limit');

  const b1 = registry.reserve(hashApiKey('amc_b'));
  assert.equal(typeof b1, 'object');
  assert.equal(registry.reserve(hashApiKey('amc_c')), 'global_limit');

  if (typeof a1 === 'object') a1.release();
  assert.equal(typeof registry.reserve(hashApiKey('amc_a')), 'object');
});

test('open sessions count against the per-key cap', () => {
  const registry = new SessionRegistry(LIMITS);
  registry.add('s1', entry('amc_a'));
  registry.add('s2', entry('amc_a'));
  assert.equal(registry.reserve(hashApiKey('amc_a')), 'key_limit');
  registry.delete('s1');
  assert.equal(typeof registry.reserve(hashApiKey('amc_a')), 'object');
});

test('evictIdle removes only sessions idle past the TTL', () => {
  let clock = 0;
  const registry = new SessionRegistry(LIMITS, () => clock);
  registry.add('old', entry('amc_a'));
  clock = 600;
  registry.add('fresh', entry('amc_a'));
  clock = 1_000;
  assert.deepEqual(registry.evictIdle().length, 1);
  assert.equal(registry.has('old'), false);
  assert.equal(registry.has('fresh'), true);

  clock = 1_500;
  registry.touch('fresh');
  clock = 2_400;
  assert.equal(registry.evictIdle().length, 0, 'touch must reset the idle clock');
});
