/**
 * @file Public storage API surface.
 *
 * Importers:
 *   import { AtomicMemoryClient } from '@atomicmemory/sdk';
 *   const client = new AtomicMemoryClient({ apiUrl, apiKey });
 *   await client.storage.put({ mode: 'pointer', uri: '...', contentType: '...' });
 *
 * Or import the typed pieces directly:
 *   import { StoredArtifact, StorageClient } from '@atomicmemory/sdk/storage';
 *
 * Type surface (`types.ts`, `interfaces.ts`, `errors.ts`) plus the
 * concrete runtime class (`client.ts`).
 */

export * from './types.js';
export * from './interfaces.js';
export * from './errors.js';
export { ConcreteStorageClient, type StorageClientConfig } from './client.js';
