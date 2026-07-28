/**
 * Unit tests for Cloud trace envelope redaction.
 */

import { describe, expect, it } from 'vitest';
import { buildCloudTraceEnvelope } from '../cloud-trace-envelope.js';

describe('buildCloudTraceEnvelope', () => {
  it('builds a v2 envelope with allowlisted summary fields', () => {
    const envelope = buildCloudTraceEnvelope({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      coreInstanceId: 'core-local-1',
      occurredAt: '2026-07-10T16:00:00Z',
      operation: 'memory.ingest',
      outcome: 'success',
      durationMs: 42,
      summary: {
        user_id: 'tenant-user-1',
        operation_detail: 'consensus ingest (2 fact(s))',
        new_memory_id: 'mem_abc',
        content_len: 42,
      },
      evidence: { source: 'core' },
    });

    expect(envelope.schema_version).toBe(2);
    expect(envelope.summary.user_id).toBe('tenant-user-1');
    expect(envelope.summary.operation_detail).toBe('consensus ingest (2 fact(s))');
    expect(envelope.summary.content_len).toBe(42);
    expect(envelope).not.toHaveProperty('actor');
  });

  it('drops disallowed summary keys including raw content previews', () => {
    const envelope = buildCloudTraceEnvelope({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      coreInstanceId: 'core-local-1',
      occurredAt: '2026-07-10T16:00:00Z',
      operation: 'memory.search',
      outcome: 'success',
      durationMs: 10,
      summary: {
        user_id: 'tenant-user-1',
        input_summary: 'secret query text',
        query_len: 17,
      },
    });

    expect(envelope.summary).toEqual({ user_id: 'tenant-user-1', query_len: 17 });
  });

  it('allowlists only bounded evidence string fields', () => {
    const envelope = buildCloudTraceEnvelope({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      coreInstanceId: 'core-local-1',
      occurredAt: '2026-07-10T16:00:00Z',
      operation: 'memory.search',
      outcome: 'success',
      durationMs: 10,
      evidence: {
        mode: 'verbatim',
        source_site: 'chatgpt',
        as_of: '2026-01-01T00:00:00Z',
        api_key: 'secret',
        nested: { route: 'search' },
        tokens: ['leak'],
      },
    });

    expect(envelope.evidence).toEqual({ mode: 'verbatim', source_site: 'chatgpt' });
  });

  it('drops oversized source_site evidence strings', () => {
    const envelope = buildCloudTraceEnvelope({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      coreInstanceId: 'core-local-1',
      occurredAt: '2026-07-10T16:00:00Z',
      operation: 'memory.ingest',
      outcome: 'success',
      durationMs: 1,
      evidence: { source_site: 'x'.repeat(121) },
    });

    expect(envelope.evidence).toEqual({});
  });
});
