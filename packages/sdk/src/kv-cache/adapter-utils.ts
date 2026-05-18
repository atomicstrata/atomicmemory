/**
 * @file Adapter Utilities
 *
 * Shared utilities for working with storage adapters.
 */

import { StorageAdapter } from './storage-adapter';

/**
 * Get unique identifier for a storage adapter
 */
export function getAdapterId(adapter: StorageAdapter): string {
  return adapter.constructor.name + '_' + ((adapter as any).id || 'default');
}
