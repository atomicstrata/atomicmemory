/**
 * @file Memory Service
 *
 * Replaces UnifiedContextService. Routes operations to the correct
 * provider and applies optional processing pipelines.
 */

import type { MemoryProvider, Packager } from './provider';
import type { MemoryProcessingPipeline } from './pipeline';
import { noopMemoryPipeline } from './pipeline';
import type { MemoryProviderRegistration } from './registration';
import { UnsupportedOperationError } from './errors';
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
} from './types';
import {
  defaultRegistry,
  type ProviderRegistry,
} from './providers/registry';

export interface MemoryServiceConfig {
  defaultProvider: string;
  providerConfigs: Record<string, unknown>;
}

export class MemoryService {
  private providers = new Map<string, MemoryProvider>();
  private pipelines = new Map<string, MemoryProcessingPipeline>();
  private defaultProviderName: string;

  constructor(private readonly config: MemoryServiceConfig) {
    this.defaultProviderName = config.defaultProvider;
  }

  async initialize(
    registry: ProviderRegistry = defaultRegistry
  ): Promise<void> {
    for (const [name, providerConfig] of Object.entries(
      this.config.providerConfigs
    )) {
      const factory = registry[name];
      if (!factory) continue;
      const registration: MemoryProviderRegistration = factory(providerConfig);
      this.providers.set(name, registration.provider);
      this.pipelines.set(
        name,
        registration.pipeline ?? noopMemoryPipeline
      );

      if (registration.provider.initialize) {
        await registration.provider.initialize();
      }
    }
  }

  getProvider(name?: string): MemoryProvider {
    const providerName = name ?? this.defaultProviderName;
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(
        `Provider "${providerName}" is not registered`
      );
    }
    return provider;
  }

  getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Provider names declared in the SDK configuration, regardless of whether
   * they have been initialized yet. Useful for UI and getter paths that
   * need to advertise capabilities before `initialize()` has run.
   */
  getConfiguredProviders(): string[] {
    return Object.keys(this.config.providerConfigs);
  }

  // -----------------------------------------------------------------------
  // Core operations
  // -----------------------------------------------------------------------

  async ingest(
    input: IngestInput,
    providerName?: string
  ): Promise<IngestResult> {
    const provider = this.getProvider(providerName);
    const pipeline = this.getPipeline(providerName);

    if (pipeline.preprocessIngest) {
      const inputs = await pipeline.preprocessIngest(input);
      const results: IngestResult[] = [];
      for (const i of inputs) {
        const result = await provider.ingest(i);
        if (pipeline.postprocessIngest) {
          await pipeline.postprocessIngest(result, i);
        }
        results.push(result);
      }
      return mergeIngestResults(results);
    }

    const result = await provider.ingest(input);
    if (pipeline.postprocessIngest) {
      await pipeline.postprocessIngest(result, input);
    }
    return result;
  }

  async search(
    request: SearchRequest,
    providerName?: string
  ): Promise<SearchResultPage> {
    const provider = this.getProvider(providerName);
    const pipeline = this.getPipeline(providerName);

    const processedRequest = pipeline.preprocessSearch
      ? await pipeline.preprocessSearch(request)
      : request;

    const page = await provider.search(processedRequest);

    return pipeline.postprocessSearch
      ? await pipeline.postprocessSearch(page, processedRequest)
      : page;
  }

  async get(
    ref: MemoryRef,
    providerName?: string
  ): Promise<Memory | null> {
    const provider = this.getProvider(providerName);
    const pipeline = this.getPipeline(providerName);

    const processedRef = pipeline.preprocessGet
      ? await pipeline.preprocessGet(ref)
      : ref;

    const memory = await provider.get(processedRef);

    return pipeline.postprocessGet
      ? await pipeline.postprocessGet(memory, processedRef)
      : memory;
  }

  async delete(
    ref: MemoryRef,
    providerName?: string
  ): Promise<void> {
    const provider = this.getProvider(providerName);
    await provider.delete(ref);
  }

  async list(
    request: ListRequest,
    providerName?: string
  ): Promise<ListResultPage> {
    const provider = this.getProvider(providerName);
    const pipeline = this.getPipeline(providerName);

    const page = await provider.list(request);

    return pipeline.postprocessList
      ? await pipeline.postprocessList(page, request)
      : page;
  }

  async package(
    request: PackageRequest,
    providerName?: string
  ): Promise<ContextPackage> {
    const provider = this.getProvider(providerName);
    const packager = provider.getExtension?.<Packager>('package');
    if (!packager) {
      throw new UnsupportedOperationError(
        provider.name,
        'package'
      );
    }
    return packager.package(request);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getPipeline(
    name?: string
  ): MemoryProcessingPipeline {
    const providerName = name ?? this.defaultProviderName;
    return (
      this.pipelines.get(providerName) ?? noopMemoryPipeline
    );
  }
}

function mergeIngestResults(
  results: IngestResult[]
): IngestResult {
  return {
    created: results.flatMap((r) => r.created),
    updated: results.flatMap((r) => r.updated),
    unchanged: results.flatMap((r) => r.unchanged),
  };
}
