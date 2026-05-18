/**
 * @file Embedding Module Exports
 * @description Public API exports for the AtomicMemory SDK embedding system
 */

// Core embedding classes
export { EmbeddingGenerator } from './embedding-generator';
export { TransformersAdapter } from './transformers-adapter';

// WASM-specific exports
export {
  WasmSemanticProcessor,
  testWebAssemblySupport,
} from './wasm-semantic-processor';

export { CacheSafetyManager, createCacheSafetyManager } from './cache-safety';

// Fallback manager removed: SDK is WASM-only

export {
  WasmFeatureFlagManager,
  createDefaultFeatureFlagManager,
  createConservativeFeatureFlagManager,
} from './feature-flags';
