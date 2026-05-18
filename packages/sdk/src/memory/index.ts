/**
 * @file Memory Module Exports
 *
 * Provider interface, concrete adapters (AtomicMemory, Mem0), and
 * supporting types. `MemoryService` is an internal implementation
 * detail of `MemoryClient`; consumers use the client instead.
 */

export * from './types';
export * from './errors';
export * from './provider';
export * from './pipeline';
export * from './registration';
export * from './atomicmemory-provider';
export * from './mem0-provider';
export * from './hindsight-provider';
export {
  filterMetaFacts,
  isMetaFact,
  resolveMetaFactPatterns,
  DEFAULT_META_FACT_PATTERNS,
  type MetaFactFilterConfig,
} from './meta-fact-filter';
