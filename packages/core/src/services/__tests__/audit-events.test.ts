/**
 * Unit tests for audit-events.ts.
 * Tests event construction, serialization, configuration, and emission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAuditEvent,
  serializeAuditEvent,
  emitAuditEvent,
  configureAudit,
  resetAuditConfig,
  isAuditEnabled,
  type AuditEvent,
} from '../audit-events.js';

beforeEach(() => {
  resetAuditConfig();
});

describe('buildAuditEvent', () => {
  it('constructs event with required fields', () => {
    const event = buildAuditEvent('memory:ingest', 'user-1', { factCount: 3 });
    expect(event.action).toBe('memory:ingest');
    expect(event.userId).toBe('user-1');
    expect(event.detail).toEqual({ factCount: 3 });
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes optional memoryId and sourceSite', () => {
    const event = buildAuditEvent(
      'memory:retrieve',
      'user-1',
      { query: 'test' },
      { memoryId: 'mem-1', sourceSite: 'claude.ai' },
    );
    expect(event.memoryId).toBe('mem-1');
    expect(event.sourceSite).toBe('claude.ai');
  });

  it('leaves optional fields undefined when not provided', () => {
    const event = buildAuditEvent('memory:delete', 'user-1', {});
    expect(event.memoryId).toBeUndefined();
    expect(event.sourceSite).toBeUndefined();
  });

  it('supports all action types', () => {
    const actions = [
      'memory:ingest', 'memory:retrieve', 'memory:update',
      'memory:delete', 'memory:supersede',
      'sanitization:block', 'sanitization:warn',
      'trust:below-threshold',
    ] as const;
    for (const action of actions) {
      const event = buildAuditEvent(action, 'user-1', {});
      expect(event.action).toBe(action);
    }
  });
});

describe('serializeAuditEvent', () => {
  it('produces [AUDIT] prefixed single-line JSON', () => {
    const event: AuditEvent = {
      timestamp: '2026-03-18T10:00:00.000Z',
      action: 'memory:ingest',
      userId: 'user-1',
      detail: { factCount: 5 },
    };
    const line = serializeAuditEvent(event);
    expect(line).toMatch(/^\[AUDIT\] \{/);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('produces valid JSON after prefix', () => {
    const event = buildAuditEvent('memory:retrieve', 'user-1', { query: 'test' });
    const line = serializeAuditEvent(event);
    const json = line.replace(/^\[AUDIT\] /, '');
    const parsed = JSON.parse(json);
    expect(parsed.action).toBe('memory:retrieve');
    expect(parsed.userId).toBe('user-1');
  });
});

describe('configureAudit / isAuditEnabled', () => {
  it('is enabled by default', () => {
    expect(isAuditEnabled()).toBe(true);
  });

  it('can be disabled', () => {
    configureAudit({ enabled: false });
    expect(isAuditEnabled()).toBe(false);
  });

  it('can be re-enabled', () => {
    configureAudit({ enabled: false });
    configureAudit({ enabled: true });
    expect(isAuditEnabled()).toBe(true);
  });

  it('resetAuditConfig restores defaults', () => {
    configureAudit({ enabled: false });
    resetAuditConfig();
    expect(isAuditEnabled()).toBe(true);
  });
});

describe('emitAuditEvent', () => {
  it('logs to console when enabled', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitAuditEvent('memory:ingest', 'user-1', { test: true });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatch(/^\[AUDIT\]/);
    spy.mockRestore();
  });

  it('does not log when disabled', () => {
    expectNoLogAfterConfig({ enabled: false });
  });

  it('does not log when stdout is disabled', () => {
    expectNoLogAfterConfig({ logToStdout: false });
  });
});

/** Configure audit, emit an event, and assert that nothing was logged. */
function expectNoLogAfterConfig(auditConfig: Parameters<typeof configureAudit>[0]) {
  configureAudit(auditConfig);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  emitAuditEvent('memory:ingest', 'user-1', { test: true });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
}
