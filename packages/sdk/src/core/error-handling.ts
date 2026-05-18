/**
 * @file AtomicMemory SDK Error Handling (Legacy Re-export)
 *
 * This file re-exports all error handling functionality from the modular
 * error-handling directory for backward compatibility.
 *
 * @deprecated Import directly from './error-handling/' subdirectory for better tree-shaking
 */

// Re-export everything from the modular error-handling system
// Note: Explicitly reference index to avoid resolving to this file name first
export * from './error-handling/index';
