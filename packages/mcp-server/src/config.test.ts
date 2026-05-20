/**
 * @file Tests for MCP config defaults used by source-only plugins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFromEnv, validateConfig } from './config.js';

test('loadConfigFromEnv defaults URL, provider, and user scope', () => {
  const config = loadConfigFromEnv({
    USER: 'machine-user',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiUrl, 'http://127.0.0.1:17350');
  assert.equal(config.apiKey, 'local-dev-key');
  assert.equal(config.provider, 'atomicmemory');
  assert.deepEqual(config.scope, { user: 'machine-user' });
});

test('loadConfigFromEnv keeps explicit scope overrides', () => {
  const config = loadConfigFromEnv({
    USER: 'machine-user',
    ATOMICMEMORY_API_URL: 'https://memory.example.com/',
    ATOMICMEMORY_API_KEY: 'am-test-key',
    ATOMICMEMORY_SCOPE_USER: 'configured-user',
    ATOMICMEMORY_SCOPE_AGENT: 'codex',
    ATOMICMEMORY_SCOPE_NAMESPACE: 'repo',
    ATOMICMEMORY_SCOPE_THREAD: 'thread-1',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiUrl, 'https://memory.example.com');
  assert.equal(config.apiKey, 'am-test-key');
  assert.deepEqual(config.scope, {
    user: 'configured-user',
    agent: 'codex',
    namespace: 'repo',
    thread: 'thread-1',
  });
});

test('validateConfig accepts plugin config without URL, key, or scope', () => {
  const config = validateConfig({});

  assert.equal(config.apiUrl, 'http://127.0.0.1:17350');
  assert.equal(config.apiKey, 'local-dev-key');
  assert.equal(config.provider, 'atomicmemory');
  assert.ok(config.scope?.user);
});

test('validateConfig does not default API key for remote AtomicMemory URL', () => {
  const config = validateConfig({
    apiUrl: 'https://memory.example.com',
  });

  assert.equal(config.apiUrl, 'https://memory.example.com');
  assert.equal(config.apiKey, undefined);
});

test('validateConfig accepts explicit plugin api key', () => {
  const config = validateConfig({
    apiUrl: 'https://memory.example.com',
    apiKey: 'am-plugin-key',
  });

  assert.equal(config.apiUrl, 'https://memory.example.com');
  assert.equal(config.apiKey, 'am-plugin-key');
});

test('validateConfig requires explicit apiUrl for mem0', () => {
  assert.throws(
    () => validateConfig({ provider: 'mem0' }),
    /provider=mem0 requires an explicit apiUrl/,
  );
});

test('loadConfigFromEnv still derives a non-empty user scope when USER vars are absent', () => {
  const config = loadConfigFromEnv({
    USER: '',
    USERNAME: '',
  } as NodeJS.ProcessEnv);

  assert.ok(config.scope.user.length > 0);
});
