/** @file Browser entry point works without process and never reads server keys. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryClient } from '../../browser';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('ATOMICMEMORY_API_KEY', 'server-only-secret');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json({ memories: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('initializes and searches using explicit credentials without a process global', async () => {
  vi.stubGlobal('process', undefined);
  const client = new MemoryClient({ providers: { atomicmemory: { apiKey: 'browser-explicit' } } });
  await client.initialize();
  const page = await client.search({ query: 'tea', scope: { user: 'browser-user' } });
  expect(page.results).toEqual([]);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('https://api.atomicstrata.ai/v1/memories/search/fast');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer browser-explicit');
});

it('requires explicit credentials without a process global', async () => {
  vi.stubGlobal('process', undefined);
  await expect(new MemoryClient().initialize()).rejects.toThrow(
    'Browser callers must pass apiKey explicitly.',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['window', 'self'])('ignores an environment key in a browser or worker with %s', async (global) => {
  vi.stubGlobal(global, {});
  await expect(new MemoryClient().initialize()).rejects.toThrow(
    'Browser callers must pass apiKey explicitly.',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not treat a browser process shim as a Node server', async () => {
  vi.stubGlobal('process', { env: { ATOMICMEMORY_API_KEY: 'shim-secret' } });
  await expect(new MemoryClient().initialize()).rejects.toThrow(
    'Browser callers must pass apiKey explicitly.',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
