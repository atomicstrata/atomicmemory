/**
 * @file Storage Module Exports
 * @description Public API exports for the AtomicMemory SDK storage system
 */

// Core storage classes
export { StorageManager } from './storage-manager';
export { BaseStorageAdapter } from './storage-adapter';
export { MemoryStorageAdapter } from './memory-storage';
export { IndexedDBStorageAdapter } from './indexeddb-storage';

// Resilience and health management
export { ResilienceManager } from './resilience-manager';
export { HealthTracker } from './health-tracker';
export { CircuitBreaker } from './circuit-breaker';
export { RepairManager } from './repair-manager';

// Validation and utilities
export { StorageValidator } from './validation';
export * from './storage-utils';
export * from './adapter-utils';

// Types and interfaces
export * from './types';
