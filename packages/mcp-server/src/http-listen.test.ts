/**
 * @file Unit tests for HTTP transport selection and listen config.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HOSTED_HTTP_LIMITS,
  DEFAULT_MCP_HTTP_PORT,
  loadHostedHttpLimits,
  loadHttpListenConfig,
  resolveTransport,
} from './http-listen.js';

test('resolveTransport defaults to stdio', () => {
  assert.equal(resolveTransport([], {}), 'stdio');
  assert.equal(resolveTransport(['--stdio'], {}), 'stdio');
});

test('resolveTransport selects http from flag or env', () => {
  assert.equal(resolveTransport(['--http'], {}), 'http');
  assert.equal(
    resolveTransport([], { ATOMICMEMORY_MCP_TRANSPORT: 'http' } as NodeJS.ProcessEnv),
    'http',
  );
});

test('resolveTransport rejects unknown env values', () => {
  assert.throws(
    () =>
      resolveTransport([], {
        ATOMICMEMORY_MCP_TRANSPORT: 'websocket',
      } as NodeJS.ProcessEnv),
    /ATOMICMEMORY_MCP_TRANSPORT/,
  );
});

test('loadHttpListenConfig defaults port 3100 and enables SSE', () => {
  const cfg = loadHttpListenConfig({});
  assert.equal(cfg.port, DEFAULT_MCP_HTTP_PORT);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.enableSse, true);
});

test('loadHttpListenConfig honors port/host/sse env', () => {
  const cfg = loadHttpListenConfig({
    ATOMICMEMORY_MCP_PORT: '3200',
    ATOMICMEMORY_MCP_HOST: '127.0.0.1',
    ATOMICMEMORY_MCP_ENABLE_SSE: '0',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.port, 3200);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.enableSse, false);
});

test('loadHttpListenConfig leaves allowedHosts unset by default', () => {
  assert.equal(loadHttpListenConfig({}).allowedHosts, undefined);
  assert.equal(
    loadHttpListenConfig({ ATOMICMEMORY_MCP_ALLOWED_HOSTS: ' , ' } as NodeJS.ProcessEnv).allowedHosts,
    undefined,
  );
});

test('loadHttpListenConfig parses a comma-separated allowed hosts list', () => {
  const cfg = loadHttpListenConfig({
    ATOMICMEMORY_MCP_ALLOWED_HOSTS: 'MCP.example.com, [::1] ,localhost',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.allowedHosts, ['mcp.example.com', '[::1]', 'localhost']);
});

test('loadHostedHttpLimits uses defaults when unset', () => {
  const limits = loadHostedHttpLimits({});
  assert.deepEqual(limits, DEFAULT_HOSTED_HTTP_LIMITS);
  assert.equal(limits.sessionIdleTtlMs, 30 * 60 * 1000);
  assert.equal(limits.authTimeoutMs, 5_000);
  assert.equal(limits.authCacheTtlMs, 60_000);
});

test('loadHostedHttpLimits honors env overrides', () => {
  const limits = loadHostedHttpLimits({
    ATOMICMEMORY_MCP_SESSION_IDLE_TTL_MS: '60000',
    ATOMICMEMORY_MCP_MAX_SESSIONS: '10',
    ATOMICMEMORY_MCP_MAX_SESSIONS_PER_KEY: '2',
    ATOMICMEMORY_MCP_AUTH_TIMEOUT_MS: '1500',
    ATOMICMEMORY_MCP_AUTH_CACHE_TTL_MS: '0',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(limits, {
    sessionIdleTtlMs: 60_000,
    maxSessions: 10,
    maxSessionsPerKey: 2,
    authTimeoutMs: 1_500,
    authCacheTtlMs: 0,
  });
});

test('loadHostedHttpLimits rejects malformed values', () => {
  for (const [name, value] of [
    ['ATOMICMEMORY_MCP_MAX_SESSIONS', '0'],
    ['ATOMICMEMORY_MCP_MAX_SESSIONS_PER_KEY', '-1'],
    ['ATOMICMEMORY_MCP_SESSION_IDLE_TTL_MS', '1.5'],
    ['ATOMICMEMORY_MCP_AUTH_TIMEOUT_MS', 'soon'],
    ['ATOMICMEMORY_MCP_AUTH_CACHE_TTL_MS', '-5'],
  ] as const) {
    assert.throws(
      () => loadHostedHttpLimits({ [name]: value } as NodeJS.ProcessEnv),
      new RegExp(name),
    );
  }
});
