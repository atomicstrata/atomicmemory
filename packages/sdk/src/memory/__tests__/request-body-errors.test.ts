/** Real HTTP regressions for transport errors after headers and during response-body reads. */
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryClient } from '../../client/memory-client';
import { MemoryProviderError, MemoryTransportError } from '../errors';
import { createHttpClient, type HttpOptions } from '../shared/http-client';
import { startRequestServer } from './shared/request-server';

const http = createHttpClient('atomicmemory');
const path = '/response-body';
const partialBody = '{"private":"backend-secret","memories":[';
const cases: {
  name: string;
  status: number;
  call: (options: HttpOptions, signal: AbortSignal) => Promise<unknown>;
}[] = [
  {
    name: 'fetchJson JSON',
    status: 200,
    call: (options, signal) => http.fetchJson(options, path, { signal }),
  },
  {
    name: 'fetchJson HTTP error text',
    status: 500,
    call: (options, signal) => http.fetchJson(options, path, { signal }),
  },
  {
    name: 'fetchVoid HTTP error text',
    status: 500,
    call: (options, signal) => http.fetchVoid(options, path, { signal }),
  },
  {
    name: 'fetchJsonOrNull JSON',
    status: 200,
    call: (options, signal) => http.fetchJsonOrNull(options, path, { signal }),
  },
  {
    name: 'fetchJsonOrNull HTTP error text',
    status: 500,
    call: (options, signal) => http.fetchJsonOrNull(options, path, { signal }),
  },
  {
    name: 'deleteIgnore404 HTTP error text',
    status: 500,
    call: (options, signal) => http.deleteIgnore404(options, path, { signal }),
  },
  {
    name: 'MemoryClient search JSON',
    status: 200,
    call: async (options, signal) => {
      const client = new MemoryClient({
        providers: {
          atomicmemory: { ...options, allowPrivateNetworks: true },
        },
      });
      await client.initialize();
      return client.search({ query: 'text', scope: { user: 'u1' }, signal });
    },
  },
];

let server: Awaited<ReturnType<typeof startRequestServer>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.stop();
  server = undefined;
});

// Wrap native fetch, not its response. Resolving this handshake proves that the
// HTTP headers reached the client before cancellation, regardless of scheduling.
function observeHeaders(): Promise<void> {
  const nativeFetch = globalThis.fetch;
  let received!: () => void;
  const headers = new Promise<void>((resolve) => {
    received = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await nativeFetch(...args);
    received();
    return response;
  });
  return headers;
}

it.each(cases)(
  'classifies post-header abort for $name',
  async ({ status, call }) => {
    server = await startRequestServer({ status, partialBody });
    const headers = observeHeaders();
    const controller = new AbortController();
    const options = {
      apiUrl: server.apiUrl,
      apiKey: 'fixture-secret',
      timeout: 10_000,
    };
    const result = call(options, controller.signal).catch(
      (error: unknown) => error,
    );
    const request = await server.arrived;
    await headers;
    controller.abort();
    const error = await result;
    expect(error).toBeInstanceOf(MemoryTransportError);
    expect(error).toMatchObject({
      provider: 'atomicmemory',
      code: 'AbortError',
    });
    if (!(error instanceof Error)) throw new Error('Expected an error');
    expect(error.message).not.toContain('backend-secret');
    expect(error.message).not.toContain('fixture-secret');
    await request.closed;
  },
);

it.each(cases)(
  'classifies post-header timeout for $name',
  async ({ status, call }) => {
    server = await startRequestServer({ status, partialBody });
    const headers = observeHeaders();
    const timeout = new AbortController();
    const timeoutFactory = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const options = {
      apiUrl: server.apiUrl,
      apiKey: 'fixture-secret',
      timeout: 10_000,
    };
    const result = call(options, caller.signal).catch(
      (error: unknown) => error,
    );
    const request = await server.arrived;
    await headers;
    // The existing boundary suite verifies native timer expiry. Here the timeout
    // signal is controlled so that expiry happens only after headers arrive.
    timeout.abort(new DOMException('fixture-secret', 'TimeoutError'));
    const error = await result;
    expect(timeoutFactory).toHaveBeenCalledWith(10_000);
    expect(error).toBeInstanceOf(MemoryTransportError);
    expect(error).toMatchObject({
      provider: 'atomicmemory',
      code: 'TimeoutError',
    });
    expect(caller.signal.aborted).toBe(false);
    if (!(error instanceof Error)) throw new Error('Expected an error');
    expect(error.message).not.toContain('backend-secret');
    expect(error.message).not.toContain('fixture-secret');
    await request.closed;
  },
);

it('keeps invalid JSON a provider error rather than a transport failure', async () => {
  server = await startRequestServer({ status: 200, bodyText: '{' });
  const client = new MemoryClient({
    providers: {
      atomicmemory: { apiUrl: server.apiUrl, allowPrivateNetworks: true },
    },
  });
  await client.initialize();
  const error = await client
    .search({ query: 'text', scope: { user: 'u1' } })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MemoryProviderError);
  expect(error).not.toBeInstanceOf(MemoryTransportError);
  expect(error).toMatchObject({ cause: expect.any(SyntaxError) });
});

it('classifies a custom post-header abort reason without exposing its message', async () => {
  server = await startRequestServer({ status: 200, partialBody });
  const headers = observeHeaders();
  const controller = new AbortController();
  const options = { apiUrl: server.apiUrl, timeout: 10_000 };
  const result = http
    .fetchJson(options, path, { signal: controller.signal })
    .catch((error: unknown) => error);
  const request = await server.arrived;
  await headers;
  controller.abort(new Error('fixture-secret'));
  const error = await result;
  expect(error).toBeInstanceOf(MemoryTransportError);
  expect(error).toMatchObject({ code: 'AbortError' });
  if (!(error instanceof MemoryTransportError))
    throw new Error('Expected a transport error');
  expect(error.message).not.toContain('fixture-secret');
  expect(error.cause?.message).not.toContain('fixture-secret');
  await request.closed;
});

it('classifies a socket failure while reading the response body', async () => {
  server = await startRequestServer({ status: 200, partialBody });
  const headers = observeHeaders();
  const controller = new AbortController();
  const options = { apiUrl: server.apiUrl, timeout: 10_000 };
  const result = http
    .fetchJson(options, path, { signal: controller.signal })
    .catch((error: unknown) => error);
  await headers;
  await server.stop();
  server = undefined;
  const error = await result;
  expect(error).toBeInstanceOf(MemoryTransportError);
  expect(error).toMatchObject({ code: 'UND_ERR_SOCKET' });
  expect(controller.signal.aborted).toBe(false);
});
