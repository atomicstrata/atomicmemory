/**
 * @file MemoryService Unit Tests
 *
 * Tests that MemoryService correctly routes operations to providers,
 * discovers extensions, and reports available providers.
 * Uses mock providers extending BaseMemoryProvider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseMemoryProvider, type Packager } from '../provider';
import { MemoryService, type MemoryServiceConfig } from '../memory-service';
import { UnsupportedOperationError } from '../errors';
import type {
  IngestInput,
  IngestResult,
  SearchRequest,
  SearchResultPage,
  MemoryRef,
  Memory,
  ListRequest,
  ListResultPage,
  Capabilities,
  PackageRequest,
  ContextPackage,
} from '../types';
import type { ProviderRegistry } from '../providers/registry';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const TEST_SCOPE = { user: 'u1', namespace: 'ns1' };

const TEST_MEMORY: Memory = {
  id: 'mem-1',
  content: 'test content',
  scope: TEST_SCOPE,
  createdAt: new Date('2026-01-01'),
};

const EMPTY_INGEST_RESULT: IngestResult = {
  created: ['mem-1'],
  updated: [],
  unchanged: [],
};

const EMPTY_SEARCH_PAGE: SearchResultPage = {
  results: [{ memory: TEST_MEMORY, score: 0.95 }],
};

const EMPTY_LIST_PAGE: ListResultPage = {
  memories: [TEST_MEMORY],
};

const BASE_CAPABILITIES: Capabilities = {
  ingestModes: ['text'],
  requiredScope: { default: ['user'] },
  extensions: {
    update: false,
    package: false,
    temporal: false,
    graph: false,
    forget: false,
    profile: false,
    reflect: false,
    versioning: false,
    batch: false,
    health: false,
  },
};

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

class MockProvider extends BaseMemoryProvider {
  readonly name = 'mock';

  doIngestSpy = vi.fn<[IngestInput], Promise<IngestResult>>();
  doSearchSpy = vi.fn<[SearchRequest], Promise<SearchResultPage>>();
  doGetSpy = vi.fn<[MemoryRef], Promise<Memory | null>>();
  doDeleteSpy = vi.fn<[MemoryRef], Promise<void>>();
  doListSpy = vi.fn<[ListRequest], Promise<ListResultPage>>();

  constructor() {
    super();
    this.doIngestSpy.mockResolvedValue(EMPTY_INGEST_RESULT);
    this.doSearchSpy.mockResolvedValue(EMPTY_SEARCH_PAGE);
    this.doGetSpy.mockResolvedValue(TEST_MEMORY);
    this.doDeleteSpy.mockResolvedValue(undefined);
    this.doListSpy.mockResolvedValue(EMPTY_LIST_PAGE);
  }

  capabilities(): Capabilities {
    return BASE_CAPABILITIES;
  }

  protected doIngest(input: IngestInput): Promise<IngestResult> {
    return this.doIngestSpy(input);
  }

  protected doSearch(request: SearchRequest): Promise<SearchResultPage> {
    return this.doSearchSpy(request);
  }

  protected doGet(ref: MemoryRef): Promise<Memory | null> {
    return this.doGetSpy(ref);
  }

  protected doDelete(ref: MemoryRef): Promise<void> {
    return this.doDeleteSpy(ref);
  }

  protected doList(request: ListRequest): Promise<ListResultPage> {
    return this.doListSpy(request);
  }
}

/** Provider that supports the Packager extension. */
class PackagerProvider extends MockProvider {
  override readonly name = 'packager-mock';
  packageSpy = vi.fn<[PackageRequest], Promise<ContextPackage>>();

  constructor() {
    super();
    this.packageSpy.mockResolvedValue({
      text: 'packaged context',
      results: [],
      tokens: 42,
      budgetConstrained: false,
    });
  }

  override capabilities(): Capabilities {
    return {
      ...BASE_CAPABILITIES,
      extensions: { ...BASE_CAPABILITIES.extensions, package: true },
    };
  }

  async package(request: PackageRequest): Promise<ContextPackage> {
    return this.packageSpy(request);
  }
}

// ---------------------------------------------------------------------------
// Test registry factory
// ---------------------------------------------------------------------------

function buildRegistry(
  providers: Record<string, BaseMemoryProvider>
): ProviderRegistry {
  const registry: ProviderRegistry = {};
  for (const [name, provider] of Object.entries(providers)) {
    registry[name] = () => ({ provider });
  }
  return registry;
}

function buildConfig(providerNames: string[]): MemoryServiceConfig {
  const providerConfigs: Record<string, unknown> = {};
  for (const name of providerNames) {
    providerConfigs[name] = {};
  }
  return { defaultProvider: providerNames[0], providerConfigs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryService', () => {
  let mockProvider: MockProvider;
  let service: MemoryService;

  beforeEach(async () => {
    mockProvider = new MockProvider();
    const registry = buildRegistry({ mock: mockProvider });
    service = new MemoryService(buildConfig(['mock']));
    await service.initialize(registry);
  });

  describe('initialize', () => {
    it('creates provider from config via registry factory', async () => {
      const provider = new MockProvider();
      const factorySpy = vi.fn(() => ({ provider }));
      const registry: ProviderRegistry = { custom: factorySpy };

      const svc = new MemoryService(buildConfig(['custom']));
      await svc.initialize(registry);

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(svc.getAvailableProviders()).toContain('custom');
    });

    it('calls provider.initialize when defined', async () => {
      const provider = new MockProvider();
      const initSpy = vi.fn().mockResolvedValue(undefined);
      provider.initialize = initSpy;

      const registry = buildRegistry({ initable: provider });
      const svc = new MemoryService(buildConfig(['initable']));
      await svc.initialize(registry);

      expect(initSpy).toHaveBeenCalledTimes(1);
    });

    it('skips providers not found in registry', async () => {
      const registry: ProviderRegistry = {};
      const svc = new MemoryService(buildConfig(['missing']));
      await svc.initialize(registry);

      expect(svc.getAvailableProviders()).toEqual([]);
    });
  });

  describe('ingest', () => {
    it('routes to the default provider and returns result', async () => {
      const input: IngestInput = {
        mode: 'text',
        content: 'hello',
        scope: TEST_SCOPE,
      };

      const result = await service.ingest(input);

      expect(mockProvider.doIngestSpy).toHaveBeenCalledWith(input);
      expect(result.created).toEqual(['mem-1']);
    });
  });

  describe('search', () => {
    it('routes to the default provider and returns results', async () => {
      const request: SearchRequest = {
        query: 'find something',
        scope: TEST_SCOPE,
      };

      const page = await service.search(request);

      expect(mockProvider.doSearchSpy).toHaveBeenCalledWith(request);
      expect(page.results).toHaveLength(1);
      expect(page.results[0].score).toBe(0.95);
    });
  });

  describe('get', () => {
    it('routes to the default provider and returns the memory', async () => {
      const ref: MemoryRef = { id: 'mem-1', scope: TEST_SCOPE };

      const memory = await service.get(ref);

      expect(mockProvider.doGetSpy).toHaveBeenCalledWith(ref);
      expect(memory).toEqual(TEST_MEMORY);
    });
  });

  describe('delete', () => {
    it('routes to the default provider', async () => {
      const ref: MemoryRef = { id: 'mem-1', scope: TEST_SCOPE };

      await service.delete(ref);

      expect(mockProvider.doDeleteSpy).toHaveBeenCalledWith(ref);
    });
  });

  describe('list', () => {
    it('routes to the default provider and returns memories', async () => {
      const request: ListRequest = { scope: TEST_SCOPE };

      const page = await service.list(request);

      expect(mockProvider.doListSpy).toHaveBeenCalledWith(request);
      expect(page.memories).toHaveLength(1);
    });
  });

  describe('package', () => {
    it('discovers Packager extension and delegates to it', async () => {
      const packagerProvider = new PackagerProvider();
      const registry = buildRegistry({ pkg: packagerProvider });
      const svc = new MemoryService(buildConfig(['pkg']));
      await svc.initialize(registry);

      const request: PackageRequest = {
        query: 'summary',
        scope: TEST_SCOPE,
        tokenBudget: 500,
      };

      const result = await svc.package(request);

      expect(packagerProvider.packageSpy).toHaveBeenCalledWith(request);
      expect(result.text).toBe('packaged context');
      expect(result.tokens).toBe(42);
    });

    it('throws UnsupportedOperationError when provider lacks packaging', async () => {
      const request: PackageRequest = {
        query: 'summary',
        scope: TEST_SCOPE,
      };

      await expect(service.package(request)).rejects.toThrow(
        UnsupportedOperationError
      );
    });
  });

  describe('getAvailableProviders', () => {
    it('returns names of all registered providers', async () => {
      const providerA = new MockProvider();
      const providerB = new MockProvider();
      const registry = buildRegistry({ alpha: providerA, beta: providerB });
      const config: MemoryServiceConfig = {
        defaultProvider: 'alpha',
        providerConfigs: { alpha: {}, beta: {} },
      };
      const svc = new MemoryService(config);
      await svc.initialize(registry);

      const names = svc.getAvailableProviders();

      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toHaveLength(2);
    });

    it('returns empty array when no providers are registered', async () => {
      const svc = new MemoryService(buildConfig(['none']));
      await svc.initialize({});

      expect(svc.getAvailableProviders()).toEqual([]);
    });
  });

  describe('provider routing with explicit name', () => {
    it('routes to a named provider instead of the default', async () => {
      const secondary = new MockProvider();
      const registry = buildRegistry({
        mock: mockProvider,
        secondary,
      });
      const config: MemoryServiceConfig = {
        defaultProvider: 'mock',
        providerConfigs: { mock: {}, secondary: {} },
      };
      const svc = new MemoryService(config);
      await svc.initialize(registry);

      const input: IngestInput = {
        mode: 'text',
        content: 'routed',
        scope: TEST_SCOPE,
      };
      await svc.ingest(input, 'secondary');

      expect(secondary.doIngestSpy).toHaveBeenCalledWith(input);
      expect(mockProvider.doIngestSpy).not.toHaveBeenCalled();
    });

    it('throws when named provider is not registered', () => {
      expect(() => service.getProvider('unknown')).toThrow(
        'Provider "unknown" is not registered'
      );
    });
  });
});
