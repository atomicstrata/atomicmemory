import { describe, it, expect } from 'vitest';
import { MemoryClient } from '../memory-client';

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
});
