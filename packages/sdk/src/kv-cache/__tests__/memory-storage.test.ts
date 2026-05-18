/**
 * @file Memory Storage Tests
 *
 * Tests for the in-memory storage adapter including CRUD operations,
 * TTL functionality, quota management, and cleanup mechanisms.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStorageAdapter } from '../memory-storage';
import { StorageQuotaExceededError } from '../storage-adapter';

describe('MemoryStorageAdapter', () => {
  let adapter: MemoryStorageAdapter;

  beforeEach(async () => {
    adapter = new MemoryStorageAdapter();
    await adapter.initialize({ maxSize: 1024 }); // 1KB for testing
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      const newAdapter = new MemoryStorageAdapter();
      await expect(newAdapter.initialize()).resolves.not.toThrow();
      await newAdapter.close();
    });

    it('should be available', () => {
      expect(adapter.isAvailable()).toBe(true);
    });

    it('should not initialize twice', async () => {
      await expect(adapter.initialize()).resolves.not.toThrow();
    });
  });

  describe('Basic CRUD Operations', () => {
    it('should store and retrieve values', async () => {
      await adapter.set('key1', 'value1');
      const result = await adapter.get('key1');

      expect(result).toBe('value1');
    });

    it('should return null for non-existent keys', async () => {
      const result = await adapter.get('non-existent');

      expect(result).toBeNull();
    });

    it('should store complex objects', async () => {
      const complexObject = {
        string: 'test',
        number: 42,
        boolean: true,
        array: [1, 2, 3],
        nested: { key: 'value' }
      };

      await adapter.set('complex', complexObject);
      const result = await adapter.get('complex');

      expect(result).toEqual(complexObject);
    });

    it('should delete existing keys', async () => {
      await adapter.set('key1', 'value1');

      const deleted = await adapter.delete('key1');
      expect(deleted).toBe(true);

      const result = await adapter.get('key1');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent keys', async () => {
      const deleted = await adapter.delete('non-existent');
      expect(deleted).toBe(false);
    });

    it('should check key existence', async () => {
      await adapter.set('key1', 'value1');

      expect(await adapter.has('key1')).toBe(true);
      expect(await adapter.has('non-existent')).toBe(false);
    });
  });

  describe('Key Management', () => {
    beforeEach(async () => {
      await adapter.set('user:1:profile', 'profile1');
      await adapter.set('user:1:settings', 'settings1');
      await adapter.set('user:2:profile', 'profile2');
      await adapter.set('global:config', 'config');
    });

    it('should return all keys', async () => {
      const keys = await adapter.keys();

      expect(keys).toHaveLength(4);
      expect(keys).toContain('user:1:profile');
      expect(keys).toContain('user:1:settings');
      expect(keys).toContain('user:2:profile');
      expect(keys).toContain('global:config');
    });

    it('should filter keys by prefix', async () => {
      const userKeys = await adapter.keys('user:1:');

      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain('user:1:profile');
      expect(userKeys).toContain('user:1:settings');
    });

    it('should clear all data', async () => {
      await adapter.clear();

      const keys = await adapter.keys();
      expect(keys).toHaveLength(0);
    });

    it('should clear data by prefix', async () => {
      await adapter.clear('user:1:');

      const allKeys = await adapter.keys();
      expect(allKeys).toHaveLength(2);
      expect(allKeys).toContain('user:2:profile');
      expect(allKeys).toContain('global:config');
    });
  });

  describe('TTL (Time To Live)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should expire items after TTL', async () => {
      await adapter.set('temp-key', 'temp-value', { ttl: 1000 });

      // Should exist immediately
      expect(await adapter.get('temp-key')).toBe('temp-value');

      // Fast-forward past TTL
      vi.advanceTimersByTime(1001);

      // Should be expired
      expect(await adapter.get('temp-key')).toBeNull();
    });

    it('should not expire items without TTL', async () => {
      await adapter.set('permanent-key', 'permanent-value');

      vi.advanceTimersByTime(10000);

      expect(await adapter.get('permanent-key')).toBe('permanent-value');
    });

    it('should handle has() with expired items', async () => {
      await adapter.set('temp-key', 'temp-value', { ttl: 1000 });

      expect(await adapter.has('temp-key')).toBe(true);

      vi.advanceTimersByTime(1001);

      expect(await adapter.has('temp-key')).toBe(false);
    });

    it('should clean up expired items automatically', async () => {
      await adapter.set('temp1', 'value1', { ttl: 500 });
      await adapter.set('temp2', 'value2', { ttl: 1000 });
      await adapter.set('permanent', 'value3');

      // Fast-forward to trigger cleanup
      vi.advanceTimersByTime(60000); // 1 minute

      const stats = await adapter.getStats();
      expect(stats.itemCount).toBe(1); // Only permanent item should remain
    });
  });

  describe('Quota Management', () => {
    it('should track storage size', async () => {
      await adapter.set('key1', 'small');
      await adapter.set('key2', 'larger value');

      const stats = await adapter.getStats();
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.itemCount).toBe(2);
    });

    it('should enforce quota limits', async () => {
      // Create a large value that exceeds our 1KB limit
      const largeValue = 'x'.repeat(2000);

      await expect(adapter.set('large', largeValue))
        .rejects.toThrow(StorageQuotaExceededError);
    });

    it('should update size when replacing values', async () => {
      await adapter.set('key', 'small');
      const stats1 = await adapter.getStats();

      await adapter.set('key', 'much larger value');
      const stats2 = await adapter.getStats();

      expect(stats2.totalSize).toBeGreaterThan(stats1.totalSize);
      expect(stats2.itemCount).toBe(stats1.itemCount); // Same count
    });

    it('should decrease size when deleting', async () => {
      await adapter.set('key1', 'value1');
      await adapter.set('key2', 'value2');

      const stats1 = await adapter.getStats();

      await adapter.delete('key1');

      const stats2 = await adapter.getStats();

      expect(stats2.totalSize).toBeLessThan(stats1.totalSize);
      expect(stats2.itemCount).toBe(stats1.itemCount - 1);
    });
  });

  describe('Batch Operations', () => {
    it('should perform batch operations', async () => {
      const operations = [
        { type: 'set' as const, key: 'key1', value: 'value1' },
        { type: 'set' as const, key: 'key2', value: 'value2' },
        { type: 'delete' as const, key: 'key3' }
      ];

      await adapter.batch(operations);

      expect(await adapter.get('key1')).toBe('value1');
      expect(await adapter.get('key2')).toBe('value2');
    });

    it('should enforce quota in batch operations', async () => {
      const operations = [
        { type: 'set' as const, key: 'large1', value: 'x'.repeat(600) },
        { type: 'set' as const, key: 'large2', value: 'x'.repeat(600) }
      ];

      await expect(adapter.batch(operations))
        .rejects.toThrow(StorageQuotaExceededError);
    });
  });

  describe('Statistics and Capabilities', () => {
    it('should provide accurate statistics', async () => {
      await adapter.set('key1', 'value1');
      await adapter.set('key2', 'value2');

      const stats = await adapter.getStats();

      expect(stats.itemCount).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.availableSize).toBeLessThan(1024);
      expect(stats.adapterType).toBe('memory');
      expect(stats.supportsTransactions).toBe(true);
      expect(stats.supportsBatch).toBe(true);
    });

    it('should provide capabilities', () => {
      const capabilities = adapter.getCapabilities();

      expect(capabilities.maxKeyLength).toBe(1000);
      expect(capabilities.maxValueSize).toBe(10 * 1024 * 1024);
      expect(capabilities.supportsExpiration).toBe(true);
      expect(capabilities.supportsTransactions).toBe(true);
      expect(capabilities.supportsBatch).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should validate keys', async () => {
      await expect(adapter.get('')).rejects.toThrow();
      await expect(adapter.set('', 'value')).rejects.toThrow();
      await expect(adapter.delete('')).rejects.toThrow();
    });

    it('should validate values', async () => {
      await expect(adapter.set('key', undefined)).rejects.toThrow();
    });

    it('should handle operations after close', async () => {
      await adapter.close();

      await expect(adapter.get('key')).rejects.toThrow();
      await expect(adapter.set('key', 'value')).rejects.toThrow();
    });
  });

  describe('Cleanup and Resource Management', () => {
    it('should clean up resources on close', async () => {
      await adapter.set('key1', 'value1');
      await adapter.set('key2', 'value2');

      await adapter.close();

      // After close, adapter should be in clean state
      expect(adapter.isAvailable()).toBe(true); // Still available for new instances
    });
  });
});
