/**
 * @file Common adapter base. Both `AtomicMemoryAdapter` and
 * `Mem0Adapter` translate the same SDK surface into the same CLI
 * shapes; the only meaningful provider-specific behavior is in the
 * capability gates (`mem0` rejects verbatim ingest + package). All
 * shared method bodies live here so `atomicmemory.ts` / `mem0.ts`
 * stay one-line shims rather than parallel copies that drift apart.
 *
 * Subclasses must:
 *   - construct the underlying SDK MemoryClient via the
 *     `buildClientConfig(profile, providerName)` helper
 *     (kept as the single SDK-construction call site)
 *   - declare a literal `providerName` matching the registered
 *     provider key
 *   - implement `packageContext` (atomicmemory delegates to
 *     `client.package`; mem0 throws unsupported_capability)
 *   - optionally override `ingestMemories` to apply provider-specific
 *     ingest gates before calling super (mem0 rejects verbatim)
 */

import type { MemoryClient } from '@atomicmemory/sdk';
import {
  cliScopeToSdkScope,
  sdkCapabilitiesToCli,
  sdkMemoryToCli,
} from './scope-mapper.js';
import {
  mapListResult,
  mapSearchHits,
  statusFromClient,
  toSdkIngestInput,
  toSdkListRequest,
  toSdkSearchRequest,
} from './shared.js';
import type { ProviderCapabilities } from '../types.js';
import type {
  AdapterAddInput,
  AdapterContextPackage,
  AdapterIngestInput,
  AdapterIngestResult,
  AdapterListInput,
  AdapterListResult,
  AdapterMemorySummary,
  AdapterPackageInput,
  AdapterRefInput,
  AdapterSearchHit,
  AdapterSearchInput,
  AdapterStatus,
  ProviderAdapter,
} from './types.js';

type SdkProviderName = 'atomicmemory' | 'mem0';

export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly providerName: SdkProviderName;
  protected readonly client: MemoryClient;
  private initialized = false;

  protected constructor(client: MemoryClient) {
    this.client = client;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.client.initialize();
    this.initialized = true;
  }

  async getStatus(): Promise<AdapterStatus> {
    await this.initialize();
    return statusFromClient(this.client, this.providerName);
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    await this.initialize();
    return sdkCapabilitiesToCli(this.client.capabilities(this.providerName));
  }

  async addMemory(input: AdapterAddInput): Promise<AdapterIngestResult> {
    return this.ingestMemories({
      mode: 'text',
      scope: input.scope,
      text: input.text,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    });
  }

  async ingestMemories(input: AdapterIngestInput): Promise<AdapterIngestResult> {
    await this.initialize();
    const result = await this.client.ingest(toSdkIngestInput(input));
    return {
      created: result.created ?? [],
      updated: result.updated ?? [],
      unchanged: result.unchanged ?? [],
    };
  }

  async searchMemories(input: AdapterSearchInput): Promise<AdapterSearchHit[]> {
    await this.initialize();
    return mapSearchHits(await this.client.search(toSdkSearchRequest(input)));
  }

  async listMemories(input: AdapterListInput): Promise<AdapterListResult> {
    await this.initialize();
    return mapListResult(await this.client.list(toSdkListRequest(input)));
  }

  async getMemory(input: AdapterRefInput): Promise<AdapterMemorySummary | null> {
    await this.initialize();
    const memory = await this.client.get({
      id: input.id,
      scope: cliScopeToSdkScope(input.scope),
    });
    return memory ? sdkMemoryToCli(memory) : null;
  }

  async deleteMemory(input: AdapterRefInput): Promise<void> {
    await this.initialize();
    await this.client.delete({
      id: input.id,
      scope: cliScopeToSdkScope(input.scope),
    });
  }

  abstract packageContext(input: AdapterPackageInput): Promise<AdapterContextPackage>;
}
