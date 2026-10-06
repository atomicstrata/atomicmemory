/** @file Exercise a real browser bundle without Node globals or embedded keys. */
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { beforeAll, expect, it, vi } from 'vitest';
import type { MemoryClient } from '../memory-client';

let code: string;

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.ATOMICMEMORY_API_KEY': JSON.stringify('build-time-secret') },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../browser.ts', import.meta.url)),
        formats: ['iife'],
        name: 'AtomicMemorySDK',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs.flatMap((output) => 'output' in output ? output.output : [])
    .find((output) => output.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Browser build produced no JavaScript.');
  code = chunk.code;
});

it('does not embed a server credential supplied to the bundler', () => {
  expect(code).toContain('AtomicMemorySDK');
  expect(code).not.toContain('build-time-secret');
});

it('runs the bundled public constructor and transport without process', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ memories: [] }));
  const sandbox: {
    fetch: typeof fetch;
    URL: typeof URL;
    AbortSignal: typeof AbortSignal;
    client?: MemoryClient;
  } = { fetch: fetchMock, URL, AbortSignal };
  runInNewContext(`${code}
    globalThis.client = new AtomicMemorySDK.MemoryClient({
      providers: { atomicmemory: { apiKey: 'explicit-browser-key' } }
    });`, sandbox);
  if (!sandbox.client) throw new Error('Bundle did not construct MemoryClient.');
  await sandbox.client.initialize();
  const page = await sandbox.client.search({ query: 'tea', scope: { user: 'browser-user' } });
  expect(page.results).toEqual([]);
  expect(fetchMock.mock.calls[0][0]).toBe('https://api.atomicstrata.ai/v1/memories/search/fast');
  expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(
    'Bearer explicit-browser-key',
  );
});
