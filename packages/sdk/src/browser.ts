/**
 * @file Browser-safe SDK entry point
 *
 * This surface is intentionally smaller than the root SDK export.
 * It exposes the client and memory-provider contracts needed by
 * browser applications without pulling in the root bundle's broader
 * storage/embedding exports.
 */

export { MemoryClient } from './client/memory-client';
export type {
  MemoryClientConfig,
  MemoryProviderConfigs,
  ProviderStatus,
} from './client/memory-client';

export * from './memory/types';
export * from './memory/errors';
export * from './memory/provider';
export * from './memory/pipeline';
export * from './memory/registration';
export * from './memory/atomicmemory-provider';
export * from './memory/mem0-provider';
export * from './memory/hindsight-provider';
