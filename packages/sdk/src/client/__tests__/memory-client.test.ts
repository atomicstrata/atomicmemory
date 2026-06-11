import { describe, it, expect, vi } from 'vitest';
import { MemoryClient } from '../memory-client';
import type { ProviderRegistry } from '../../memory/providers/registry';

describe('MemoryClient', () => {
  it('throws if no providers are configured', () => {
    expect(() => new MemoryClient({ providers: {} })).toThrow(
      /at least one provider/i
    );
  });

  it('rejects operations before initialize()', async () => {
    const client = new MemoryClient({
      providers: { atomicmemory: { apiUrl: 'http://localhost:17350' } },
    });
    await expect(
      client.ingest({ mode: 'text', content: 'x', scope: { user: 'u' } })
    ).rejects.toThrow(/not initialized/i);
  });

  it('capabilities() throws before initialize()', () => {
    const client = new MemoryClient({
      providers: { atomicmemory: { apiUrl: 'http://localhost:17350' } },
    });
    expect(() => client.capabilities()).toThrow(/not initialized/i);
  });

  it('getExtension() throws before initialize()', () => {
    const client = new MemoryClient({
      providers: { atomicmemory: { apiUrl: 'http://localhost:17350' } },
    });
    expect(() => client.getExtension('any.extension')).toThrow(
      /not initialized/i
    );
  });

  it('getProviderStatus reports configured but uninitialized providers', () => {
    const client = new MemoryClient({
      providers: {
        atomicmemory: { apiUrl: 'http://localhost:17350' },
        mem0: { apiUrl: 'http://localhost:8888' },
      },
    });
    const statuses = client.getProviderStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => !s.initialized)).toBe(true);
    expect(statuses.every((s) => s.capabilities === null)).toBe(true);
    expect(statuses.map((s) => s.name).sort()).toEqual(['atomicmemory', 'mem0']);
  });

  it('atomicmemory getter returns undefined before initialize()', () => {
    const client = new MemoryClient({
      providers: { atomicmemory: { apiUrl: 'http://localhost:17350' } },
    });
    expect(client.atomicmemory).toBeUndefined();
  });

  it('atomicmemory getter is undefined when the provider is not configured', () => {
    const client = new MemoryClient({
      providers: { mem0: { apiUrl: 'http://localhost:8888' } },
    });
    expect(client.atomicmemory).toBeUndefined();
  });

  it('initializes hindsight through the default provider registry', async () => {
    const client = new MemoryClient({
      providers: {
        hindsight: { apiUrl: 'https://api.hindsight.vectorize.io' },
      },
    });

    await client.initialize();

    expect(client.capabilities().extensions.reflect).toBe(true);
  });

  it('concurrent initialize calls run the factory exactly once', async () => {
    const mockProvider = {
      name: 'mock',
      ingest: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      capabilities: vi.fn().mockReturnValue({ extensions: {} }),
    };
    const factory = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      return { provider: mockProvider };
    });
    const registry: ProviderRegistry = { mock: factory };
    const client = new MemoryClient({ providers: { mock: {} } });

    await Promise.all([client.initialize(registry), client.initialize(registry)]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.getProvider('mock')).toBe(mockProvider);
  });

  it('rejected initialize is sticky — factory called once, error re-thrown on retry', async () => {
    const markerError = new Error('factory-boom');
    const factory = vi.fn(async () => { throw markerError; });
    const registry: ProviderRegistry = { mock: factory };
    const client = new MemoryClient({ providers: { mock: {} } });

    await expect(client.initialize(registry)).rejects.toThrow(markerError);
    await expect(client.initialize(registry)).rejects.toThrow(markerError);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('getProviderStatus reports no provider as initialized after a failed initialize()', async () => {
    const okProvider = {
      name: 'ok',
      ingest: vi.fn(),
      search: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      capabilities: vi.fn().mockReturnValue({ extensions: {} }),
    };
    const registry: ProviderRegistry = {
      ok: () => ({ provider: okProvider }),
      bad: async () => { throw new Error('bad-init'); },
    };
    const client = new MemoryClient({ providers: { ok: {}, bad: {} } });

    await expect(client.initialize(registry)).rejects.toThrow('bad-init');

    const statuses = client.getProviderStatus();
    expect(statuses.every((s) => !s.initialized)).toBe(true);
  });
});
