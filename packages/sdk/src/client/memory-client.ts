/**
 * @file MemoryClient — primary public API for the memory-layer SDK
 *
 * Pure memory operations: ingest, search, package, list, get, delete,
 * capability inspection, and provider namespace handles. No policy
 * gating, no platform/targetDomain parameters — applications that need
 * those layer them on top of this client.
 */

import { MemoryService } from '../memory/memory-service';
import type { MemoryProvider } from '../memory/provider';
import type { AtomicMemoryProviderConfig } from '../memory/atomicmemory-provider/types';
import type { AtomicMemoryHandle } from '../memory/atomicmemory-provider/handle';
import type { Mem0ProviderConfig } from '../memory/mem0-provider/types';
import type { HindsightProviderConfig } from '../memory/hindsight-provider/types';
import type {
  IngestInput,
  IngestResult,
  SearchRequest,
  SearchResultPage,
  MemoryRef,
  Memory,
  ListRequest,
  ListResultPage,
  PackageRequest,
  ContextPackage,
  Capabilities,
} from '../memory/types';
import {
  defaultRegistry,
  type ProviderRegistry,
} from '../memory/providers/registry';

/**
 * Provider configuration map. Each key names a provider; the value is
 * that provider's configuration object.
 */
export interface MemoryProviderConfigs {
  atomicmemory?: AtomicMemoryProviderConfig;
  mem0?: Mem0ProviderConfig;
  hindsight?: HindsightProviderConfig;
  [providerName: string]: unknown;
}

/**
 * MemoryClient configuration.
 */
export interface MemoryClientConfig {
  /** Provider configurations keyed by provider name. */
  providers: MemoryProviderConfigs;
  /** Name of the default provider. If omitted, the first configured provider wins. */
  defaultProvider?: string;
}

/**
 * Status summary for each configured provider.
 */
export interface ProviderStatus {
  name: string;
  initialized: boolean;
  capabilities: Capabilities | null;
}

/**
 * MemoryClient — pure memory-layer API.
 *
 * @example
 * ```ts
 * const memory = new MemoryClient({
 *   providers: { atomicmemory: { apiUrl: 'http://localhost:17350' } },
 * });
 * await memory.initialize();
 * await memory.ingest({ mode: 'text', content: 'hi', scope: { user: 'u1' } });
 * const results = await memory.search({ query: 'hi', scope: { user: 'u1' } });
 * ```
 */
export class MemoryClient {
  private readonly service: MemoryService;
  private initialized = false;

  constructor(config: MemoryClientConfig) {
    const providerConfigs: Record<string, unknown> = { ...config.providers };
    const defaultProvider =
      config.defaultProvider ?? pickFirstProviderKey(providerConfigs);

    if (!defaultProvider) {
      throw new Error(
        'MemoryClient requires at least one provider config. ' +
        'Pass e.g. { providers: { atomicmemory: { apiUrl: "..." } } }.'
      );
    }

    this.service = new MemoryService({
      defaultProvider,
      providerConfigs,
    });
  }

  /**
   * Initialize all configured providers. Must be called before any
   * memory operation. Idempotent.
   */
  async initialize(registry: ProviderRegistry = defaultRegistry): Promise<void> {
    if (this.initialized) return;
    await this.service.initialize(registry);
    this.initialized = true;
  }

  /**
   * Write memory(ies). Input supports `text`, `messages`, or `memory` modes.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.assertInitialized();
    return this.service.ingest(input);
  }

  /**
   * Ingest without any application-layer gating. Equivalent to `ingest()`
   * on the core client; application wrappers override the gated variant
   * while delegating this path straight through.
   */
  async ingestDirect(input: IngestInput): Promise<IngestResult> {
    this.assertInitialized();
    return this.service.ingest(input);
  }

  /**
   * Search for memories matching the request.
   */
  async search(request: SearchRequest): Promise<SearchResultPage> {
    this.assertInitialized();
    return this.service.search(request);
  }

  /**
   * Search without application-layer gating. See `ingestDirect` for the
   * rationale.
   */
  async searchDirect(request: SearchRequest): Promise<SearchResultPage> {
    this.assertInitialized();
    return this.service.search(request);
  }

  /**
   * Build an injection-ready context package from a scoped request.
   * Provider must implement the `package` extension.
   */
  async package(request: PackageRequest): Promise<ContextPackage> {
    this.assertInitialized();
    return this.service.package(request);
  }

  /**
   * Package without application-layer gating.
   */
  async packageDirect(request: PackageRequest): Promise<ContextPackage> {
    this.assertInitialized();
    return this.service.package(request);
  }

  /**
   * Fetch a single memory by reference.
   */
  async get(ref: MemoryRef): Promise<Memory | null> {
    this.assertInitialized();
    return this.service.get(ref);
  }

  /**
   * Delete a single memory by reference.
   */
  async delete(ref: MemoryRef): Promise<void> {
    this.assertInitialized();
    return this.service.delete(ref);
  }

  /**
   * List memories within a scope.
   */
  async list(request: ListRequest): Promise<ListResultPage> {
    this.assertInitialized();
    return this.service.list(request);
  }

  /**
   * Report the capability surface of the default (or named) provider.
   *
   * @throws if the named provider is unknown or not initialized.
   */
  capabilities(providerName?: string): Capabilities {
    this.assertInitialized();
    return this.service.getProvider(providerName).capabilities();
  }

  /**
   * Resolve a named extension on the default (or named) provider.
   * Returns `undefined` when the provider does not advertise the
   * extension.
   *
   * @throws if the named provider is unknown or not initialized.
   *
   * @example
   * ```ts
   * const pkg = memory.getExtension<Packager>('package');
   * ```
   */
  getExtension<T>(extensionName: string, providerName?: string): T | undefined {
    this.assertInitialized();
    const provider = this.service.getProvider(providerName);
    return provider.getExtension?.<T>(extensionName);
  }

  /**
   * Aggregate status of all configured providers. Never throws:
   * uninitialized providers report `initialized: false` and
   * `capabilities: null`.
   */
  getProviderStatus(): ProviderStatus[] {
    const configured = this.service.getConfiguredProviders();
    const available = new Set(this.service.getAvailableProviders());
    return configured.map((name) => {
      if (!available.has(name)) {
        return { name, initialized: false, capabilities: null };
      }
      return {
        name,
        initialized: true,
        capabilities: this.service.getProvider(name).capabilities(),
      };
    });
  }

  /**
   * Access the full AtomicMemory namespace handle (lifecycle, audit,
   * lessons, config, agents). Returns `undefined` when the client is
   * not yet initialized, the `atomicmemory` provider was not included
   * in the `providers` config, or that provider does not advertise the
   * namespace handle. This getter intentionally never throws — callers
   * can guard with a truthy check and let the handle's own methods
   * raise if used incorrectly.
   */
  get atomicmemory(): AtomicMemoryHandle | undefined {
    if (!this.initialized) return undefined;
    if (!this.service.getConfiguredProviders().includes('atomicmemory')) {
      return undefined;
    }
    const provider = this.service.getProvider('atomicmemory');
    return provider.getExtension?.<AtomicMemoryHandle>('atomicmemory.base');
  }

  /**
   * Low-level escape hatch for callers that need the concrete provider.
   */
  getProvider(name?: string): MemoryProvider {
    this.assertInitialized();
    return this.service.getProvider(name);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'MemoryClient is not initialized. Call `await client.initialize()` first.'
      );
    }
  }
}

function pickFirstProviderKey(providers: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(providers)) {
    if (value !== undefined && key !== 'default') return key;
  }
  return undefined;
}
