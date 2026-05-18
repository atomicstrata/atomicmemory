/**
 * Unit tests for the deferred AUDN reconciliation module.
 * Tests the decision logic (shouldDeferAudn) and serialization,
 * without requiring a database connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../config.js', () => ({
  config: {
    deferredAudnEnabled: false,
    deferredAudnBatchSize: 20,
    auditLoggingEnabled: false,
  },
}));

import { config } from '../../config.js';
import { shouldDeferAudn } from '../deferred-audn.js';

describe('shouldDeferAudn', () => {
  beforeEach(() => {
    (config as any).deferredAudnEnabled = false;
  });

  it('returns false when deferred AUDN is disabled', () => {
    (config as any).deferredAudnEnabled = false;
    expect(shouldDeferAudn(false, 3)).toBe(false);
  });

  it('returns true when enabled, fast AUDN did not resolve, and candidates exist', () => {
    (config as any).deferredAudnEnabled = true;
    expect(shouldDeferAudn(false, 3)).toBe(true);
  });

  it('returns false when fast AUDN already resolved', () => {
    (config as any).deferredAudnEnabled = true;
    expect(shouldDeferAudn(true, 3)).toBe(false);
  });

  it('returns false when no candidates exist', () => {
    (config as any).deferredAudnEnabled = true;
    expect(shouldDeferAudn(false, 0)).toBe(false);
  });

  it('returns false when fast AUDN resolved and no candidates', () => {
    (config as any).deferredAudnEnabled = true;
    expect(shouldDeferAudn(true, 0)).toBe(false);
  });
});
