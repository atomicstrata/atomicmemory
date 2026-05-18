/**
 * @file @atomicmemory/sdk public surface
 *
 * Backend-agnostic memory-layer SDK. Pluggable providers, local
 * embeddings, storage adapters, semantic search.
 *
 * @example
 * ```typescript
 * import { MemoryClient } from '@atomicmemory/sdk';
 *
 * const memory = new MemoryClient({
 *   providers: { atomicmemory: { apiUrl: 'http://localhost:3050' } },
 * });
 * await memory.initialize();
 * await memory.ingest({ mode: 'text', content: 'hello', scope: { user: 'u1' } });
 * const results = await memory.search({ query: 'hello', scope: { user: 'u1' } });
 * ```
 */

// Primary client — `AtomicMemoryClient` aggregates the memory and
// storage namespaces. `MemoryClient` remains available for
// applications that only need memory operations.
export {
  AtomicMemoryClient,
  type AtomicMemoryClientConfig,
} from './client/atomic-memory-client';

export { MemoryClient } from './client/memory-client';
export type {
  MemoryClientConfig,
  MemoryProviderConfigs,
  ProviderStatus,
} from './client/memory-client';

// Types
export * from './types';

// Event system
export { EventEmitter, type EventMap } from './core/events';

// Error handling
export {
  AtomicMemoryError,
  StorageError,
  EmbeddingError,
  SearchError,
  ConfigurationError,
  NetworkError,
  RetryableOperation,
  withRetry,
  ErrorContext,
  ErrorUtils,
  type RetryPolicy,
} from './core/error-handling/';

// KV cache used by embeddings and local search. New artifact-storage
// integrations should use the `./storage` subpath.
export { StorageManager } from './kv-cache/storage-manager';
export { MemoryStorageAdapter } from './kv-cache/memory-storage';
export { IndexedDBStorageAdapter } from './kv-cache/indexeddb-storage';
export type { StorageAdapter, StorageStats } from './kv-cache/storage-adapter';

// KV cache validation
export {
  StorageValidator,
  validateKey,
  validateValue,
  validateKeyValue,
  assertValidKey,
  assertValidValue,
  assertValidKeyValue,
  DEFAULT_VALIDATION_CONFIG,
} from './kv-cache/validation';
export type { ValidationConfig, ValidationResult } from './kv-cache/validation';

// Storage API for the public `client.storage` namespace.
export * from './storage';

// Logging
export {
  Logger,
  getLogger,
  configureLogging,
  setLogLevel,
  logger,
} from './utils/logger';
export type {
  LogLevel,
  LogContext,
  LogEntry,
  LoggerConfig,
} from './utils/logger';

// Debug logging
export {
  setDebugHandler,
  setDebugEnabled,
  isDebugEnabled,
  debugLog,
  debugInfo,
  debugWarn,
  debugError,
} from './utils/debug-logger';
export type { DebugLogEntry, DebugLogHandler } from './utils/debug-logger';

// Embedding
export { EmbeddingGenerator } from './embedding/embedding-generator';
export { TransformersAdapter } from './embedding/transformers-adapter';
export { WasmSemanticProcessor } from './embedding/wasm-semantic-processor';
export { testWebAssemblySupport } from './embedding/wasm-semantic-processor';

// Search
export { SemanticSearch } from './search/semantic-search';
export { cosineSimilarity } from './search/similarity-calculator';
export type {
  SemanticSearchResult,
  SearchOptions,
  StoredContext,
} from './search/semantic-search/types';

// Utilities
export { PerformanceMonitor } from './utils/performance';
export { DebugTools } from './utils/debugging';
export * from './utils/validation';
export {
  getEnvironment,
  isTestEnvironment,
  isDevelopmentEnvironment,
  isExtensionEnvironment,
} from './utils/environment';

// Runtime configuration — singleton consumed by application wrappers
// that need to initialize environment settings at SDK startup.
export { RuntimeConfig, runtimeConfig } from './core/runtime-config';

// Memory system — types, provider interface, concrete adapters.
// `MemoryService` is intentionally not re-exported from root; consumers
// use `MemoryClient` (above) as the canonical API.
export * from './memory/types';
export * from './memory/errors';
export * from './memory/provider';
export * from './memory/pipeline';
export * from './memory/registration';
export * from './memory/atomicmemory-provider';
export * from './memory/mem0-provider';
export * from './memory/hindsight-provider';

// Version information
export const SDK_VERSION = '1.0.0';
export const API_VERSION = '1.0';
