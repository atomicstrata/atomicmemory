/** @file Public MemoryClient Cloud defaults and credential isolation contracts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryClient } from '../../index';
import { AtomicMemoryProvider } from '../../memory/atomicmemory-provider';

const fetchMock = vi.fn<typeof fetch>();
const scope = { user: 'demo-user' };
const cloudHosts = ['api.atomicstrata.ai', 'api.dev.atomicstrata.ai', 'api.staging.atomicstrata.ai'];

beforeEach(() => {
  vi.stubEnv('ATOMICMEMORY_API_KEY', 'environment-secret');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async () => Response.json({ memories: [], count: 0 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function search(client: MemoryClient): Promise<void> {
  await client.initialize();
  const page = await client.search({ query: 'tea', scope });
  expect(page.results).toEqual([]);
}

function expectRequest(url: string, apiKey?: string): void {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [input, init] = fetchMock.mock.calls[0];
  expect(input).toBe(url);
  expect(new Headers(init?.headers).get('Authorization')).toBe(
    apiKey ? `Bearer ${apiKey}` : null,
  );
}

describe('MemoryClient Cloud lifecycle and defaults', () => {
  it('supports the public zero-argument constructor, scope, and initialization lifecycle', async () => {
    const client = new MemoryClient();
    expect(client.getProviderStatus()).toEqual([
      { name: 'atomicmemory', initialized: false, capabilities: null },
    ]);
    await expect(client.search({ query: 'tea', scope })).rejects.toThrow(
      'Call `await client.initialize()` first.',
    );
    await search(client);
    expectRequest('https://api.atomicstrata.ai/v1/memories/search/fast', 'environment-secret');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.user_id).toBe('demo-user');
  });

  it.each([{}, { providers: { atomicmemory: {} } }])(
    'uses Cloud when provider configuration or URL is omitted: %j',
    async (config) => {
      await search(new MemoryClient(config));
      expectRequest('https://api.atomicstrata.ai/v1/memories/search/fast', 'environment-secret');
    },
  );
});

describe('MemoryClient Cloud missing credentials', () => {
  it.each([undefined, '', ' \t\n '])('rejects missing or blank environment credentials: %j', async (key) => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', key);
    const client = new MemoryClient();
    await expect(client.initialize()).rejects.toThrow(
      'Set ATOMICMEMORY_API_KEY in your Node/server environment or pass providers.atomicmemory.apiKey.',
    );
    await expect(client.search({ query: 'tea', scope })).rejects.toThrow('not initialized');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', ' \t '])('does not replace an explicit blank Cloud key with the environment key: %j', async (apiKey) => {
    const client = new MemoryClient({ providers: { atomicmemory: { apiKey } } });
    await expect(client.initialize()).rejects.toThrow('AtomicMemory Cloud requires an API key.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MemoryClient Cloud credential selection', () => {
  it('uses an explicit key with the default Cloud URL', async () => {
    await search(new MemoryClient({ providers: { atomicmemory: { apiKey: 'explicit-secret' } } }));
    expectRequest('https://api.atomicstrata.ai/v1/memories/search/fast', 'explicit-secret');
  });

  it('honors an explicit Cloud key over the local development environment key', async () => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', 'local-dev-key');
    await search(new MemoryClient({ providers: { atomicmemory: { apiKey: 'explicit-secret' } } }));
    expectRequest('https://api.atomicstrata.ai/v1/memories/search/fast', 'explicit-secret');
  });

  it('recognizes a normalized explicit Cloud URL', async () => {
    await search(new MemoryClient({ providers: { atomicmemory: {
      apiUrl: ' HTTPS://API.ATOMICSTRATA.AI:443/ ',
    } } }));
    expectRequest('HTTPS://API.ATOMICSTRATA.AI:443/v1/memories/search/fast', 'environment-secret');
  });

  it.each(cloudHosts)('reads the environment key for first-party Cloud host %s', async (host) => {
    await search(new MemoryClient({ providers: { atomicmemory: { apiUrl: `https://${host}` } } }));
    expectRequest(`https://${host}/v1/memories/search/fast`, 'environment-secret');
  });

  it.each(cloudHosts)('requires credentials for first-party Cloud host %s', async (host) => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', undefined);
    const client = new MemoryClient({ providers: { atomicmemory: { apiUrl: `https://${host}` } } });
    await expect(client.initialize()).rejects.toThrow('AtomicMemory Cloud requires an API key.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MemoryClient Cloud URL aliases and transport', () => {
  it.each(cloudHosts)('rejects HTTP for Cloud host %s even with an explicit key', async (host) => {
    const client = new MemoryClient({ providers: { atomicmemory: {
      apiUrl: `http://${host}`, apiKey: 'explicit-secret',
    } } });
    await expect(client.initialize()).rejects.toThrow('AtomicMemory Cloud requires HTTPS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(cloudHosts)('recognizes case, default port, and trailing-dot aliases of %s', async (host) => {
    const apiUrl = `https://${host.toUpperCase()}.:443/`;
    await search(new MemoryClient({ providers: { atomicmemory: { apiUrl } } }));
    expectRequest(`${apiUrl.slice(0, -1)}/v1/memories/search/fast`, 'environment-secret');
  });
});

describe('MemoryClient Cloud credential isolation', () => {
  it('honors explicit URL, key, and API version', async () => {
    await search(new MemoryClient({ providers: { atomicmemory: {
      apiUrl: 'https://custom.example/memory/', apiKey: 'custom-secret', apiVersion: 'v2',
    } } }));
    expectRequest('https://custom.example/memory/v2/memories/search/fast', 'custom-secret');
  });

  it.each([
    'http://localhost:17350', 'https://custom.example',
    'https://api.atomicstrata.ai:8443',
    'https://api.atomicstrata.ai.evil.example',
    'https://api.atomicstrata.ai@evil.example',
  ])('never forwards the environment key to %s', async (apiUrl) => {
    await search(new MemoryClient({ providers: { atomicmemory: { apiUrl } } }));
    expectRequest(`${apiUrl}/v1/memories/search/fast`);
  });

  it('does not inherit the environment key for a Cloud URL containing credentials', async () => {
    const client = new MemoryClient({ providers: { atomicmemory: {
      apiUrl: 'https://user:password@api.atomicstrata.ai',
    } } });
    await expect(client.initialize()).rejects.toThrow('AtomicMemory Cloud requires an API key.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MemoryClient default-provider validation', () => {
  it.each(['mem0', 'hindsight', 'custom', 'toString'])('rejects an unconfigured default provider %s', (defaultProvider) => {
    expect(() => new MemoryClient({ defaultProvider })).toThrow(
      'MemoryClient defaultProvider must name a configured provider.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit default that is absent from the configured provider map', () => {
    expect(() => new MemoryClient({
      providers: { atomicmemory: {} }, defaultProvider: 'mem0',
    })).toThrow('Pass its configuration in providers.');
  });

  it('applies the same defaults to direct AtomicMemoryProvider callers', async () => {
    const provider = new AtomicMemoryProvider({});
    const page = await provider.search({ query: 'tea', scope });
    expect(page.results).toEqual([]);
    expectRequest('https://api.atomicstrata.ai/v1/memories/search/fast', 'environment-secret');
  });
});

describe('MemoryClient other providers', () => {
  it('does not require a Cloud key for explicit Mem0 and Hindsight providers', async () => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', undefined);
    const client = new MemoryClient({
      providers: {
        mem0: { apiUrl: 'http://localhost:8888' },
        hindsight: { apiUrl: 'http://localhost:8889' },
      },
      defaultProvider: 'hindsight',
    });
    await client.initialize();
    expect(client.getProviderStatus().map(({ name, initialized }) => ({ name, initialized }))).toEqual([
      { name: 'mem0', initialized: true }, { name: 'hindsight', initialized: true },
    ]);
    expect(client.getProvider().name).toBe('hindsight');
  });

  it('preserves a custom registry and explicit default provider', async () => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', undefined);
    const provider = new AtomicMemoryProvider({ apiUrl: 'http://localhost:17350' });
    const client = new MemoryClient({ providers: { custom: {} }, defaultProvider: 'custom' });
    await client.initialize({ custom: () => ({ provider }) });
    expect(client.getProvider()).toBe(provider);
    await client.search({ query: 'tea', scope });
    expectRequest('http://localhost:17350/v1/memories/search/fast');
  });
});

describe('MemoryClient rejects local development credentials for Cloud', () => {
  const cloudUrls = [undefined, ...cloudHosts, ...cloudHosts.map((host) => `${host.toUpperCase()}.:443`)]
    .map((host) => host ? `https://${host}` : undefined);
  it.each(cloudUrls)('rejects explicit and environment local keys before requests to %s', async (apiUrl) => {
    for (const key of ['local-dev-key', ' local-dev-key ']) {
      vi.stubEnv('ATOMICMEMORY_API_KEY', key);
      const clients = [new MemoryClient({ providers: { atomicmemory: { apiUrl } } }),
        new MemoryClient({ providers: { atomicmemory: { apiUrl, apiKey: key } } })];
      if (!apiUrl) clients.push(new MemoryClient());
      for (const client of clients) {
        await expect(client.initialize()).rejects.toThrow(
          'The local Core development key is not valid for AtomicMemory Cloud.',
        );
      }
      expect(() => new AtomicMemoryProvider({ apiUrl, apiKey: key })).toThrow(
        'The local Core development key is not valid for AtomicMemory Cloud.',
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MemoryClient local development keys outside Cloud', () => {
  it.each(['http://localhost:17350', 'https://custom.example'])('preserves explicit keys but withholds environment keys for %s', async (apiUrl) => {
    vi.stubEnv('ATOMICMEMORY_API_KEY', 'local-dev-key');
    await search(new MemoryClient({ providers: { atomicmemory: { apiUrl } } }));
    expectRequest(`${apiUrl}/v1/memories/search/fast`);
    fetchMock.mockClear();
    await search(new MemoryClient({ providers: { atomicmemory: { apiUrl, apiKey: 'local-dev-key' } } }));
    expectRequest(`${apiUrl}/v1/memories/search/fast`, 'local-dev-key');
  });
});
