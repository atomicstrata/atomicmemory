/**
 * @file Integration tests for hosted MCP HTTP + Bearer auth.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryClient } from '@atomicmemory/sdk';
import { startHttpServer, type StartHttpServerOptions } from './http-server.js';
import { createCloudApiKeyValidator, type ApiKeyValidator } from './auth.js';
import type { ServerConfig } from './config.js';

const BASE: ServerConfig = {
  apiUrl: 'https://api.example.com',
  provider: 'atomicmemory',
  scope: { user: 'http-test' },
  scopeLock: false,
};

test('GET /healthz returns ok without auth', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_ok']) });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await running.close();
  }
});

test('POST /mcp without Bearer returns 401', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_ok']) });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeBody()),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'unauthorized');
  } finally {
    await running.close();
  }
});

test('POST /mcp with invalid Bearer returns 401', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_ok']) });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer amc_bad',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeBody()),
    });
    assert.equal(res.status, 401);
  } finally {
    await running.close();
  }
});

test('valid Bearer scopes MemoryClient and tools/list works', async () => {
  const seenKeys: string[] = [];
  const running = await startTestServer({
    validKeys: new Set(['amc_tenant_a']),
    onClientKey: (key) => seenKeys.push(key),
  });

  try {
    const init = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer amc_tenant_a',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeBody()),
    });
    assert.equal(init.status, 200);
    const sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId, 'expected mcp-session-id header');
    assert.deepEqual(seenKeys, ['amc_tenant_a']);

    // Drain initialize body before follow-up (session may stream SSE).
    await init.text();

    const list = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer amc_tenant_a',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    assert.equal(list.status, 200);
    const payload = await readJsonRpcResult(list);
    const tools = (payload.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === 'memory_search'));
    assert.ok(tools.some((t) => t.name === 'memory_ingest'));
  } finally {
    await running.close();
  }
});

test('session rejects a different Bearer than the one that opened it', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a', 'amc_b']),
  });

  try {
    const init = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer amc_a',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initializeBody()),
    });
    assert.equal(init.status, 200);
    const sessionId = init.headers.get('mcp-session-id');
    assert.ok(sessionId);
    await init.text();

    const hijack = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer amc_b',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });
    assert.equal(hijack.status, 401);
  } finally {
    await running.close();
  }
});

interface TestServerOptions {
  validKeys: Set<string>;
  onClientKey?: (key: string) => void;
  enableSse?: boolean;
  allowedHosts?: string[];
  limits?: StartHttpServerOptions['limits'];
  baseConfig?: ServerConfig;
  validateApiKey?: ApiKeyValidator;
  memoryClient?: MemoryClient;
}

async function startTestServer(
  opts: TestServerOptions,
): Promise<Awaited<ReturnType<typeof startHttpServer>>> {
  return startHttpServer({
    baseConfig: opts.baseConfig ?? BASE,
    listen: {
      host: '127.0.0.1',
      port: 0,
      enableSse: opts.enableSse ?? false,
      ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
    },
    ...(opts.limits ? { limits: opts.limits } : {}),
    validateApiKey: opts.validateApiKey ?? (async (_url, key) => opts.validKeys.has(key)),
    buildDeps: {
      initClient: async (config) => {
        assert.ok(config.apiKey, 'session config must carry Bearer apiKey');
        opts.onClientKey?.(config.apiKey);
        return opts.memoryClient ?? fakeMemoryClient();
      },
      initEntities: () => null,
    },
  });
}

function fakeMemoryClient(): MemoryClient {
  return {
    initialize: async () => undefined,
  } as unknown as MemoryClient;
}

function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'atomicmemory-http-test', version: '0.0.0' },
    },
  };
}

async function readJsonRpcResult(
  res: Response,
): Promise<{ result?: unknown }> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (contentType.includes('application/json')) {
    return JSON.parse(text) as { result?: unknown };
  }
  // Streamable HTTP may return text/event-stream with a data: line.
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      return JSON.parse(line.slice(5).trim()) as { result?: unknown };
    }
  }
  throw new Error(`unexpected MCP response: ${text.slice(0, 200)}`);
}

function mcpHeaders(key: string, sessionId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
}

async function initialize(port: number, key: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(key),
    body: JSON.stringify(initializeBody()),
  });
}

async function openSession(port: number, key: string): Promise<string> {
  const init = await initialize(port, key);
  assert.equal(init.status, 200);
  const sessionId = init.headers.get('mcp-session-id');
  assert.ok(sessionId, 'expected mcp-session-id header');
  await init.text();
  return sessionId;
}

function toolsListBody(id = 2): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
}

/**
 * Open a legacy SSE stream and read until the server announces the
 * session's POST endpoint. Returns the session ID and an abort handle.
 */
async function openSseStream(
  port: number,
  key: string,
): Promise<{ sessionId: string; close: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/sse`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`SSE stream ended early: ${buffered}`);
    buffered += decoder.decode(value, { stream: true });
    const match = /sessionId=([0-9a-f-]+)/.exec(buffered);
    if (match) {
      return { sessionId: match[1]!, close: () => controller.abort() };
    }
  }
}

// Regression: the SSE handlers discarded their promises, so a POST with a
// different (valid) key threw UnauthorizedError as an unhandled rejection
// and crashed the whole process for every tenant.
test('SSE session rejects a different Bearer with 401 and keeps serving', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a', 'amc_b']),
    enableSse: true,
  });
  const stream = await openSseStream(running.port, 'amc_a');
  try {
    const url = `http://127.0.0.1:${running.port}/messages?sessionId=${stream.sessionId}`;
    const hijack = await fetch(url, {
      method: 'POST',
      headers: mcpHeaders('amc_b'),
      body: toolsListBody(),
    });
    assert.equal(hijack.status, 401);
    assert.equal(((await hijack.json()) as { error: string }).error, 'unauthorized');

    // Give a stray rejection a chance to surface before checking liveness.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    assert.equal(health.status, 200);

    const owner = await fetch(url, {
      method: 'POST',
      headers: mcpHeaders('amc_a'),
      body: toolsListBody(),
    });
    assert.equal(owner.status, 202);
    await owner.text();
  } finally {
    stream.close();
    await running.close();
  }
});

test('SSE POST to an unknown session returns 404', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_a']), enableSse: true });
  try {
    const res = await fetch(
      `http://127.0.0.1:${running.port}/messages?sessionId=00000000-0000-0000-0000-000000000000`,
      { method: 'POST', headers: mcpHeaders('amc_a'), body: toolsListBody() },
    );
    assert.equal(res.status, 404);
  } finally {
    await running.close();
  }
});

test('unknown mcp-session-id returns 404 with JSON-RPC -32001 so clients re-initialize', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_a']) });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders('amc_a', 'not-a-live-session'),
      body: toolsListBody(),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32001);
    assert.equal(body.error.message, 'Session not found');
  } finally {
    await running.close();
  }
});

test('non-initialize request without a session ID stays 400', async () => {
  const running = await startTestServer({ validKeys: new Set(['amc_a']) });
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders('amc_a'),
      body: toolsListBody(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32000);
  } finally {
    await running.close();
  }
});

test('upstream key-validation failure returns 503 and opens no session', async () => {
  let clients = 0;
  const running = await startTestServer({
    validKeys: new Set(),
    onClientKey: () => {
      clients += 1;
    },
    validateApiKey: createCloudApiKeyValidator({
      fetchImpl: (async () => new Response('upstream down', { status: 503 })) as typeof fetch,
    }),
  });
  try {
    const res = await initialize(running.port, 'amc_a');
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'auth_unavailable');
    assert.equal(res.headers.get('mcp-session-id'), null);
    assert.equal(clients, 0);
  } finally {
    await running.close();
  }
});

test('per-key session cap returns 429 without affecting other keys', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a', 'amc_b']),
    limits: { maxSessionsPerKey: 2, maxSessions: 10 },
  });
  try {
    await openSession(running.port, 'amc_a');
    await openSession(running.port, 'amc_a');
    const third = await initialize(running.port, 'amc_a');
    assert.equal(third.status, 429);
    await third.text();
    await openSession(running.port, 'amc_b');
  } finally {
    await running.close();
  }
});

test('global session cap returns 429', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a', 'amc_b', 'amc_c']),
    limits: { maxSessionsPerKey: 10, maxSessions: 2 },
  });
  try {
    await openSession(running.port, 'amc_a');
    await openSession(running.port, 'amc_b');
    const third = await initialize(running.port, 'amc_c');
    assert.equal(third.status, 429);
    await third.text();
  } finally {
    await running.close();
  }
});

test('idle sessions are evicted after the TTL and free their slot', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a']),
    limits: { sessionIdleTtlMs: 40, maxSessionsPerKey: 1 },
  });
  try {
    const sessionId = await openSession(running.port, 'amc_a');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stale = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders('amc_a', sessionId),
      body: toolsListBody(),
    });
    assert.equal(stale.status, 404);
    await stale.text();
    // The per-key cap of 1 would refuse this if the idle session were kept.
    await openSession(running.port, 'amc_a');
  } finally {
    await running.close();
  }
});

test('wrong-key requests do not keep another tenant session from idling out', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a', 'amc_b']),
    limits: { sessionIdleTtlMs: 120 },
  });
  try {
    const sessionId = await openSession(running.port, 'amc_a');
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const probe = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders('amc_b', sessionId),
        body: toolsListBody(),
      });
      await probe.text();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const owner = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: 'POST',
      headers: mcpHeaders('amc_a', sessionId),
      body: toolsListBody(),
    });
    assert.equal(owner.status, 404);
    await owner.text();
  } finally {
    await running.close();
  }
});

test('allowed hosts reject other Host headers on MCP routes but not /healthz', async () => {
  const running = await startTestServer({
    validKeys: new Set(['amc_a']),
    allowedHosts: ['mcp.example.com'],
  });
  try {
    const res = await initialize(running.port, 'amc_a');
    assert.equal(res.status, 403);
    await res.text();
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await running.close();
  }

  const allowed = await startTestServer({
    validKeys: new Set(['amc_a']),
    allowedHosts: ['127.0.0.1'],
  });
  try {
    await openSession(allowed.port, 'amc_a');
  } finally {
    await allowed.close();
  }
});

test('hosted tool calls without scope.user fail instead of using a shared identity', async () => {
  const searches: unknown[] = [];
  const running = await startTestServer({
    validKeys: new Set(['amc_a']),
    baseConfig: { ...BASE, scope: {}, requireScopeUser: true },
    memoryClient: {
      initialize: async () => undefined,
      search: async (args: unknown) => {
        searches.push(args);
        return { results: [] };
      },
    } as unknown as MemoryClient,
  });
  try {
    const sessionId = await openSession(running.port, 'amc_a');
    const call = (args: Record<string, unknown>, id: number) =>
      fetch(`http://127.0.0.1:${running.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders('amc_a', sessionId),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'memory_search', arguments: args },
        }),
      });

    const missing = await readJsonRpcResult(await call({ query: 'q' }, 3));
    assert.match(JSON.stringify(missing), /scope\.user required/);
    assert.equal(searches.length, 0);

    const ok = await readJsonRpcResult(await call({ query: 'q', scope: { user: 'end-user-1' } }, 4));
    assert.ok(ok.result, 'explicit scope.user must succeed');
    assert.deepEqual((searches[0] as { scope: unknown }).scope, { user: 'end-user-1' });
  } finally {
    await running.close();
  }
});
