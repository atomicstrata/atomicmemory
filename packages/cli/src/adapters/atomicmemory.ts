/**
 * @file AtomicMemory provider adapter. Wraps the SDK MemoryClient
 * configured against the atomicmemory provider. Common adapter
 * behavior lives in `BaseAdapter`; this class only carries the
 * provider name and the `packageContext` implementation (the
 * capability that mem0 explicitly does not support).
 *
 * Construction takes a ClientFactory so unit tests can inject a fake
 * MemoryClient without hitting the network. Production wiring uses
 * `defaultAtomicMemoryClientFactory(profile)` which calls
 * `new MemoryClient(...)` against the SDK Node entrypoint
 * (NOT `/browser`; that was V0's mistake).
 */

import {
  MemoryClient,
  type FilterExpr as SdkFilterExpr,
  type PackageRequest as SdkPackageRequest,
} from '@atomicmemory/sdk';
import { BaseAdapter } from './base.js';
import { buildClientConfig, mapSearchHits } from './shared.js';
import { cliScopeToSdkScope } from './scope-mapper.js';
import type { CliProfileShape } from '../config/schema.js';
import { CliError } from '../types.js';
import type {
  AdapterContextPackage,
  AdapterPackageInput,
} from './types.js';

export type ClientFactory = (profile: CliProfileShape) => MemoryClient;

/**
 * Default factory used in production. Configures `provider:
 * 'atomicmemory'` against the resolved profile. apiKey is forwarded
 * only when the runtime resolved one (env > stdin overlay > profile).
 */
const defaultAtomicMemoryClientFactory: ClientFactory = (profile) =>
  new MemoryClient(buildClientConfig(profile, 'atomicmemory'));

interface AtomicMemoryAdapterOptions {
  profile: CliProfileShape;
  clientFactory?: ClientFactory;
}

export class AtomicMemoryAdapter extends BaseAdapter {
  readonly providerName = 'atomicmemory' as const;

  constructor(options: AtomicMemoryAdapterOptions) {
    if (options.profile.provider !== 'atomicmemory') {
      throw new CliError(
        'usage',
        `AtomicMemoryAdapter requires profile.provider="atomicmemory"; got "${options.profile.provider}"`,
      );
    }
    const factory = options.clientFactory ?? defaultAtomicMemoryClientFactory;
    super(factory(options.profile));
  }

  async packageContext(input: AdapterPackageInput): Promise<AdapterContextPackage> {
    await this.initialize();
    const req: SdkPackageRequest = {
      query: input.query,
      scope: cliScopeToSdkScope(input.scope),
    };
    if (input.limit !== undefined) req.limit = input.limit;
    if (input.tokenBudget !== undefined) req.tokenBudget = input.tokenBudget;
    if (input.format !== undefined) req.format = input.format;
    if (input.filterJson !== undefined) {
      req.filter = input.filterJson as SdkFilterExpr;
    }
    if (input.reranker !== undefined) req.reranker = input.reranker;
    const pkg = await this.client.package(req);
    return {
      text: pkg.text,
      tokens: pkg.tokens,
      hits: mapSearchHits({ results: pkg.results }),
      budgetConstrained: pkg.budgetConstrained,
    };
  }
}
