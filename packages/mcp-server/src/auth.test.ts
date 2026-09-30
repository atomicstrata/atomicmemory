/**
 * @file Unit tests for Bearer auth helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthUnavailableError,
  createCloudApiKeyValidator,
  extractBearerToken,
  requireBearerToken,
  UnauthorizedError,
} from './auth.js';
import type { IncomingMessage } from 'node:http';

test('extractBearerToken accepts Bearer tokens', () => {
  assert.equal(extractBearerToken('Bearer amc_test'), 'amc_test');
  assert.equal(extractBearerToken('bearer amc_test'), 'amc_test');
});

test('extractBearerToken rejects missing or malformed headers', () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer '), null);
});

test('requireBearerToken throws UnauthorizedError without Bearer', () => {
  const req = { headers: {} } as IncomingMessage;
  assert.throws(() => requireBearerToken(req), UnauthorizedError);
});

test('createCloudApiKeyValidator rejects 401/403', async () => {
  const calls: string[] = [];
  for (const status of [401, 403]) {
    const validate = createCloudApiKeyValidator({
      fetchImpl: (async (url, init) => {
        calls.push(String(url));
        const auth = (init?.headers as Record<string, string>).Authorization;
        assert.equal(auth, 'Bearer amc_bad');
        return new Response('nope', { status });
      }) as typeof fetch,
    });
    assert.equal(await validate('https://api.example.com', 'amc_bad'), false);
  }
  assert.match(calls[0]!, /^https:\/\/api\.example\.com\/v1\/memories\/health$/);
});

test('createCloudApiKeyValidator accepts only 2xx responses', async () => {
  const validate = createCloudApiKeyValidator({
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  });
  assert.equal(await validate('https://api.example.com/', 'amc_ok'), true);
});

test('createCloudApiKeyValidator treats other statuses as auth unavailable', async () => {
  for (const status of [301, 400, 404, 429, 500, 502, 503]) {
    const validate = createCloudApiKeyValidator({
      fetchImpl: (async () => new Response('{}', { status })) as typeof fetch,
    });
    await assert.rejects(validate('https://api.example.com', 'amc_ok'), AuthUnavailableError, `status ${status}`);
  }
});

test('createCloudApiKeyValidator treats network failures as auth unavailable', async () => {
  const validate = createCloudApiKeyValidator({
    fetchImpl: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(validate('https://api.example.com', 'amc_ok'), AuthUnavailableError);
});

test('createCloudApiKeyValidator times out a hung probe', async () => {
  const validate = createCloudApiKeyValidator({
    timeoutMs: 20,
    fetchImpl: ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch,
  });
  // AbortSignal.timeout timers are unref'd; hold the loop open for the test.
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    const started = Date.now();
    await assert.rejects(validate('https://api.example.com', 'amc_ok'), AuthUnavailableError);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('createCloudApiKeyValidator caches successes until the TTL expires', async () => {
  let clock = 1_000;
  let probes = 0;
  const validate = createCloudApiKeyValidator({
    cacheTtlMs: 60_000,
    now: () => clock,
    fetchImpl: (async () => {
      probes += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(await validate('https://api.example.com', 'amc_ok'), true);
  assert.equal(await validate('https://api.example.com', 'amc_ok'), true);
  assert.equal(probes, 1, 'second call must be served from the cache');

  assert.equal(await validate('https://api.example.com', 'amc_other'), true);
  assert.equal(probes, 2, 'a different key must be probed');

  clock += 60_001;
  assert.equal(await validate('https://api.example.com', 'amc_ok'), true);
  assert.equal(probes, 3, 'an expired entry must be re-probed');
});

test('createCloudApiKeyValidator never caches failures', async () => {
  const statuses = [503, 401, 200];
  let probes = 0;
  const validate = createCloudApiKeyValidator({
    fetchImpl: (async () => {
      const status = statuses[probes] ?? 200;
      probes += 1;
      return new Response('{}', { status });
    }) as typeof fetch,
  });

  await assert.rejects(validate('https://api.example.com', 'amc_k'), AuthUnavailableError);
  assert.equal(await validate('https://api.example.com', 'amc_k'), false);
  assert.equal(await validate('https://api.example.com', 'amc_k'), true);
  assert.equal(probes, 3);
});

test('createCloudApiKeyValidator with cacheTtlMs 0 probes every time', async () => {
  let probes = 0;
  const validate = createCloudApiKeyValidator({
    cacheTtlMs: 0,
    fetchImpl: (async () => {
      probes += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  await validate('https://api.example.com', 'amc_ok');
  await validate('https://api.example.com', 'amc_ok');
  assert.equal(probes, 2);
});
