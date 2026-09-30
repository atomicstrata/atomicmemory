/**
 * @file Tests for MCP config defaults used by source-only plugins.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFromEnv, loadHostedHttpConfigFromEnv, validateConfig } from './config.js';

test('loadConfigFromEnv uses explicit ATOMICMEMORY_API_URL', () => {
  const config = loadConfigFromEnv({
    USER: 'machine-user',
    ATOMICMEMORY_API_URL: 'https://memory.example.com/',
    ATOMICMEMORY_API_KEY: 'am-test-key',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiUrl, 'https://memory.example.com');
  assert.equal(config.apiKey, 'am-test-key');
});

test('loadConfigFromEnv defaults to Cloud when only an API key is set', () => {
  const config = loadConfigFromEnv({
    ATOMICMEMORY_API_KEY: 'amc_cloud_test',
    USER: 'machine-user',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiUrl, 'https://api.atomicstrata.ai');
  assert.equal(config.apiKey, 'amc_cloud_test');
  assert.equal(config.provider, 'atomicmemory');
  assert.deepEqual(config.scope, { user: 'machine-user' });
  assert.equal(config.scopeLock, false);
});

test('loadConfigFromEnv defaults to local Core when URL and key are unset', () => {
  const config = loadConfigFromEnv({ USER: 'machine-user' } as NodeJS.ProcessEnv);

  assert.equal(config.apiUrl, 'http://127.0.0.1:17350');
  assert.equal(config.apiKey, 'local-dev-key');
  assert.equal(config.provider, 'atomicmemory');
});

test('loadConfigFromEnv enables scopeLock from ATOMICMEMORY_SCOPE_LOCK', () => {
  const local = { USER: 'u', ATOMICMEMORY_API_URL: 'http://127.0.0.1:17350' };
  const enabled = loadConfigFromEnv({ ...local, ATOMICMEMORY_SCOPE_LOCK: 'true' } as NodeJS.ProcessEnv);
  assert.equal(enabled.scopeLock, true);

  const oneEnabled = loadConfigFromEnv({ ...local, ATOMICMEMORY_SCOPE_LOCK: '1' } as NodeJS.ProcessEnv);
  assert.equal(oneEnabled.scopeLock, true);

  const other = loadConfigFromEnv({ ...local, ATOMICMEMORY_SCOPE_LOCK: 'no' } as NodeJS.ProcessEnv);
  assert.equal(other.scopeLock, false);
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

test('validateConfig defaults to Cloud when only apiKey is set', () => {
  const config = validateConfig({ apiKey: 'amc_cloud_test' });

  assert.equal(config.apiUrl, 'https://api.atomicstrata.ai');
  assert.equal(config.apiKey, 'amc_cloud_test');
  assert.equal(config.provider, 'atomicmemory');
  assert.ok(config.scope?.user);
});

test('validateConfig defaults to local Core when apiUrl and apiKey are unset', () => {
  const config = validateConfig({});

  assert.equal(config.apiUrl, 'http://127.0.0.1:17350');
  assert.equal(config.apiKey, 'local-dev-key');
});

test('equivalent local origins receive the development API key', () => {
  for (const apiUrl of ['HTTP://LOCALHOST:17350', 'http://localhost:017350']) {
    const config = validateConfig({ apiUrl });
    assert.equal(config.apiKey, 'local-dev-key');
  }
});

test('validateConfig does not default API key for remote AtomicMemory URL', () => {
  const config = validateConfig({
    apiUrl: 'https://memory.example.com',
  });

  assert.equal(config.apiUrl, 'https://memory.example.com');
  assert.equal(config.apiKey, undefined);
});

test('equivalent AtomicMemory Cloud origins require an explicit API key', () => {
  const urls = [
    'https://API.atomicstrata.ai',
    'https://api.atomicstrata.ai:443/v1',
    'https://api.dev.atomicstrata.ai',
    'https://api.staging.atomicstrata.ai',
  ];
  for (const apiUrl of urls) {
    assert.throws(
      () => validateConfig({ apiUrl }),
      /ATOMICMEMORY_API_KEY is required for AtomicMemory Cloud/,
    );
  }
});

test('explicit Cloud URL fails closed without an API key', () => {
  assert.throws(
    () =>
      loadConfigFromEnv({
        ATOMICMEMORY_API_URL: 'https://api.atomicstrata.ai',
      } as NodeJS.ProcessEnv),
    /ATOMICMEMORY_API_KEY is required for AtomicMemory Cloud/,
  );
});

test('missing Cloud key error points local Core users at the local API URL', () => {
  assert.throws(
    () =>
      loadConfigFromEnv({
        ATOMICMEMORY_API_URL: 'https://api.atomicstrata.ai',
      } as NodeJS.ProcessEnv),
    /set ATOMICMEMORY_API_URL=http:\/\/127\.0\.0\.1:17350/,
  );
});

test('the local Core development key is rejected for every Cloud origin', () => {
  const urls = [
    'https://api.atomicstrata.ai',
    'https://api.dev.atomicstrata.ai',
    'https://api.staging.atomicstrata.ai',
  ];
  for (const apiUrl of urls) {
    assert.throws(
      () => validateConfig({ apiUrl, apiKey: 'local-dev-key' }),
      /local Core development key and is not valid for AtomicMemory Cloud/,
    );
  }
  assert.throws(
    () => loadConfigFromEnv({ ATOMICMEMORY_API_KEY: 'local-dev-key' } as NodeJS.ProcessEnv),
    /ATOMICMEMORY_API_URL=http:\/\/127\.0\.0\.1:17350/,
  );
});

test('Cloud hostnames over plain http are refused before any key is used', () => {
  const urls = [
    'http://api.atomicstrata.ai',
    'http://API.atomicstrata.ai.',
    'http://api.dev.atomicstrata.ai:80',
    'http://api.staging.atomicstrata.ai/v1',
  ];
  for (const apiUrl of urls) {
    for (const apiKey of ['amc_real_project_key', 'local-dev-key', undefined]) {
      assert.throws(() => validateConfig({ apiUrl, apiKey }), /must use https for AtomicMemory Cloud/);
    }
  }
  assert.throws(
    () =>
      loadConfigFromEnv({
        ATOMICMEMORY_API_URL: 'http://api.atomicstrata.ai',
        ATOMICMEMORY_API_KEY: 'amc_real_project_key',
      } as NodeJS.ProcessEnv),
    /must use https/,
  );
  // Self-hosted http origins are not Cloud and stay allowed.
  assert.equal(
    validateConfig({ apiUrl: 'http://core.internal:8080', apiKey: 'k' }).apiUrl,
    'http://core.internal:8080',
  );
});

test('the local Core development key still works for local Core', () => {
  const config = validateConfig({ apiUrl: 'http://127.0.0.1:17350', apiKey: 'local-dev-key' });
  assert.equal(config.apiKey, 'local-dev-key');
});

test('hosted HTTP Cloud config relies on per-request keys', () => {
  for (const processKey of [undefined, 'amc_process_key']) {
    const config = loadHostedHttpConfigFromEnv({
      ATOMICMEMORY_API_URL: 'https://api.atomicstrata.ai',
      ATOMICMEMORY_API_KEY: processKey,
      USER: 'hosted-test',
    });

    assert.equal(config.apiUrl, 'https://api.atomicstrata.ai');
    assert.equal(config.apiKey, undefined);
  }
});

test('hosted HTTP never infers the scope user from the OS or env identity', () => {
  const config = loadHostedHttpConfigFromEnv({
    ATOMICMEMORY_API_URL: 'https://api.atomicstrata.ai',
    USER: 'appuser',
    USERNAME: 'appuser',
  });

  assert.equal(config.scope?.user, undefined);
  assert.equal(config.requireScopeUser, true);
});

test('hosted HTTP keeps an explicitly configured scope user', () => {
  const config = loadHostedHttpConfigFromEnv({
    ATOMICMEMORY_API_URL: 'https://api.atomicstrata.ai',
    ATOMICMEMORY_SCOPE_USER: 'configured-user',
    USER: 'appuser',
  });

  assert.deepEqual(config.scope, { user: 'configured-user' });
});

test('stdio config still infers the scope user and does not require it per call', () => {
  const config = loadConfigFromEnv({
    ATOMICMEMORY_API_URL: 'http://127.0.0.1:17350',
    USER: 'machine-user',
  } as NodeJS.ProcessEnv);

  assert.deepEqual(config.scope, { user: 'machine-user' });
  assert.equal(config.requireScopeUser, undefined);
});

test('hosted HTTP requires an explicit API URL', () => {
  assert.throws(
    () => loadHostedHttpConfigFromEnv({ ATOMICMEMORY_API_URL: '   ' }),
    /ATOMICMEMORY_API_URL is required for hosted HTTP/,
  );
  assert.throws(
    () => loadHostedHttpConfigFromEnv({ ATOMICMEMORY_API_KEY: 'amc_cloud_test' }),
    /ATOMICMEMORY_API_URL is required for hosted HTTP/,
  );
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
  assert.throws(
    () => loadConfigFromEnv({ ATOMICMEMORY_PROVIDER: 'mem0', ATOMICMEMORY_API_URL: '   ' }),
    /provider=mem0 requires an explicit apiUrl/,
  );
});

test('loadConfigFromEnv still derives a non-empty user scope when USER vars are absent', () => {
  const config = loadConfigFromEnv({
    ATOMICMEMORY_API_KEY: 'amc_cloud_test',
    USER: '',
    USERNAME: '',
  } as NodeJS.ProcessEnv);

  assert.ok(config.scope.user.length > 0);
});
