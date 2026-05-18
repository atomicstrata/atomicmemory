/**
 * @file `AtomicMemoryClient` — primary public surface for the SDK.
 *
 * Aggregates `memory` (the memory-layer API) and `storage` (the
 * direct-storage API) under one client so callers see a coherent
 * single entry point:
 *
 *   import { AtomicMemoryClient } from '@atomicmemory/sdk';
 *   const client = new AtomicMemoryClient({
 *     apiUrl: 'http://localhost:3050',
 *     apiKey: process.env.ATOMICMEMORY_API_KEY!,
 *     userId: 'u1',
 *   });
 *   await client.memory.initialize();
 *   const artifact = await client.storage.put({
 *     mode: 'pointer',
 *     uri: 'https://example.com/file.pdf',
 *     contentType: 'application/pdf',
 *   });
 *
 * v1 SDK is server-side only. Browser bundles must proxy through a
 * trusted server, such as an application-owned API boundary.
 *
 * Applications that only need memory operations can still use
 * `MemoryClient` directly. New integrations should prefer
 * `AtomicMemoryClient.memory`.
 */

import { MemoryClient, type MemoryClientConfig } from './memory-client';
import { ConcreteStorageClient } from '../storage/client';
import type { StorageClient } from '../storage/interfaces';

/**
 * Constructor config for the aggregator. All three transport fields
 * (`apiUrl`, `apiKey`, `userId`) are REQUIRED — they back both the
 * storage namespace and the default AtomicMemory memory provider.
 * Memory-only consumers should still pass `apiUrl` (it doubles as
 * the default memory provider's `apiUrl`); the `memory` block then
 * narrows the registration further if a non-default provider mix is
 * needed.
 *
 * `userId` is the owner-scope seam the storage routes accept until a
 * real auth seam ships. `fetch` is an optional override; defaults to
 * the Node global.
 */
export interface AtomicMemoryClientConfig {
  apiUrl: string;
  apiKey: string;
  userId: string;
  /** Optional fetch override — defaults to the Node global. */
  fetch?: typeof fetch;
  /** Memory-provider registration. Defaults to a single AtomicMemory
   * provider pointing at `apiUrl`. */
  memory?: MemoryClientConfig;
}

/**
 * Primary public client. Holds a `memory` namespace (`MemoryClient`)
 * and a `storage` namespace (`StorageClient`).
 */
export class AtomicMemoryClient {
  readonly memory: MemoryClient;
  readonly storage: StorageClient;

  constructor(config: AtomicMemoryClientConfig) {
    if (!config.apiUrl) {
      throw new Error('AtomicMemoryClient: apiUrl is required');
    }
    if (!config.apiKey) {
      throw new Error('AtomicMemoryClient: apiKey is required');
    }
    if (!config.userId) {
      throw new Error('AtomicMemoryClient: userId is required');
    }
    // Default provider registration MUST forward the apiKey so the
    // memory namespace shares the storage namespace's auth contract.
    // The earlier shape dropped it silently — memory requests went
    // out unauthenticated even when the caller supplied `apiKey`,
    // failing with 401 against any core deployment that gates `/v1/*`
    // (every deployment since the auth middleware landed).
    this.memory = new MemoryClient(
      config.memory ?? {
        providers: {
          atomicmemory: { apiUrl: config.apiUrl, apiKey: config.apiKey },
        },
      },
    );
    this.storage = new ConcreteStorageClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      userId: config.userId,
      fetch: config.fetch,
    });
  }
}
