/**
 * @file AtomicMemory namespace audit HTTP wiring
 *
 * Covers the 3 audit methods: summary, recent, trail. Core's audit
 * routes are user-scoped (memories.ts:481/493/506). Tests verify
 * request/response shape, snake→camel mapping on recent mutations,
 * Date deserialization, and the no-workspace-fields guarantee.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import type { AtomicMemoryHandle } from '../handle';
import {
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://example.invalid';
const USER_ID = 'u1';

function createHandle(): AtomicMemoryHandle {
  return new AtomicMemoryProvider({ apiUrl: API_URL }).getExtension<AtomicMemoryHandle>(
    'atomicmemory.base',
  )!;
}

function capturedUrl(
  mockFetch: ReturnType<typeof vi.fn>,
): string {
  return mockFetch.mock.calls[0][0] as string;
}

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe('atomicmemory.audit.summary', () => {
  it('GETs /v1/memories/audit/summary with user_id query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        total_versions: 42,
        active_versions: 30,
        superseded_versions: 12,
        total_claims: 25,
        by_mutation_type: { add: 20, update: 10, supersede: 12 },
      }),
    );

    const handle = createHandle();
    const result = await handle.audit.summary(USER_ID);

    expect(capturedUrl(mockFetch)).toBe(
      `${API_URL}/v1/memories/audit/summary?user_id=${USER_ID}`,
    );
    expect(result).toEqual({
      totalVersions: 42,
      activeVersions: 30,
      supersededVersions: 12,
      totalClaims: 25,
      byMutationType: { add: 20, update: 10, supersede: 12 },
    });
  });
});

// ---------------------------------------------------------------------------
// recent
// ---------------------------------------------------------------------------

describe('atomicmemory.audit.recent', () => {
  const rawMutation = {
    id: 'v1',
    claim_id: 'c1',
    user_id: USER_ID,
    memory_id: 'm1',
    content: 'fact content',
    mutation_type: 'update',
    mutation_reason: 'contradicted by newer evidence',
    actor_model: 'gpt-4o-mini',
    contradiction_confidence: 0.87,
    previous_version_id: 'v0',
    superseded_by_version_id: null,
    valid_from: '2026-04-01T00:00:00.000Z',
    valid_to: null,
    created_at: '2026-04-01T00:05:00.000Z',
  };

  it('GETs /v1/memories/audit/recent with user_id query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ mutations: [rawMutation], count: 1 }),
    );

    const handle = createHandle();
    const result = await handle.audit.recent(USER_ID);

    expect(capturedUrl(mockFetch)).toBe(
      `${API_URL}/v1/memories/audit/recent?user_id=${USER_ID}`,
    );
    expect(result.count).toBe(1);
    expect(result.mutations).toHaveLength(1);
  });

  it('forwards the optional limit query param', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ mutations: [], count: 0 }),
    );
    const handle = createHandle();
    await handle.audit.recent(USER_ID, 50);
    const url = capturedUrl(mockFetch);
    expect(url).toContain('limit=50');
  });

  it('maps snake_case rows to camelCase and coerces timestamps to Date', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ mutations: [rawMutation], count: 1 }),
    );

    const handle = createHandle();
    const result = await handle.audit.recent(USER_ID);
    const record = result.mutations[0];

    expect(record.id).toBe('v1');
    expect(record.claimId).toBe('c1');
    expect(record.userId).toBe(USER_ID);
    expect(record.memoryId).toBe('m1');
    expect(record.mutationType).toBe('update');
    expect(record.mutationReason).toBe('contradicted by newer evidence');
    expect(record.actorModel).toBe('gpt-4o-mini');
    expect(record.contradictionConfidence).toBe(0.87);
    expect(record.previousVersionId).toBe('v0');
    expect(record.supersededByVersionId).toBeNull();
    expect(record.validFrom).toBeInstanceOf(Date);
    expect(record.validFrom.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(record.validTo).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('coerces valid_to to a Date when present', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        mutations: [{ ...rawMutation, valid_to: '2026-04-02T00:00:00.000Z' }],
        count: 1,
      }),
    );
    const handle = createHandle();
    const result = await handle.audit.recent(USER_ID);
    expect(result.mutations[0].validTo).toBeInstanceOf(Date);
    expect(result.mutations[0].validTo?.toISOString()).toBe(
      '2026-04-02T00:00:00.000Z',
    );
  });
});

// ---------------------------------------------------------------------------
// trail
// ---------------------------------------------------------------------------

describe('atomicmemory.audit.trail', () => {
  it('GETs /v1/memories/:id/audit with user_id query param', async () => {
    // Core serializes Dates as ISO strings on the wire; response has strings.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memory_id: 'm1',
        version_count: 2,
        trail: [
          {
            version_id: 'v1',
            claim_id: 'c1',
            content: 'initial claim',
            mutation_type: 'add',
            mutation_reason: null,
            actor_model: null,
            contradiction_confidence: null,
            previous_version_id: null,
            superseded_by_version_id: 'v2',
            valid_from: '2026-04-01T00:00:00.000Z',
            valid_to: '2026-04-02T00:00:00.000Z',
            memory_id: 'm1',
          },
        ],
      }),
    );

    const handle = createHandle();
    const result = await handle.audit.trail('m1', USER_ID);

    expect(capturedUrl(mockFetch)).toBe(
      `${API_URL}/v1/memories/m1/audit?user_id=${USER_ID}`,
    );
    expect(result.memoryId).toBe('m1');
    expect(result.versionCount).toBe(2);
    expect(result.trail).toHaveLength(1);
    expect(result.trail[0].validFrom).toBeInstanceOf(Date);
    expect(result.trail[0].validFrom.toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
    expect(result.trail[0].validTo).toBeInstanceOf(Date);
    expect(result.trail[0].mutationType).toBe('add');
    expect(result.trail[0].supersededByVersionId).toBe('v2');
  });

  it('handles empty trails', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memory_id: 'm1', trail: [], version_count: 0 }),
    );
    const handle = createHandle();
    const result = await handle.audit.trail('m1', USER_ID);
    expect(result.trail).toEqual([]);
    expect(result.versionCount).toBe(0);
  });

  it('coerces null valid_to to a null Date (end of version range)', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        memory_id: 'm1',
        version_count: 1,
        trail: [
          {
            version_id: 'v1',
            claim_id: 'c1',
            content: 'active',
            mutation_type: 'add',
            mutation_reason: null,
            actor_model: null,
            contradiction_confidence: null,
            previous_version_id: null,
            superseded_by_version_id: null,
            valid_from: '2026-04-01T00:00:00.000Z',
            valid_to: null,
            memory_id: 'm1',
          },
        ],
      }),
    );
    const handle = createHandle();
    const result = await handle.audit.trail('m1', USER_ID);
    expect(result.trail[0].validTo).toBeNull();
  });

  it('URL-encodes memoryId into the path', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ memory_id: 'm 1', trail: [], version_count: 0 }),
    );
    const handle = createHandle();
    await handle.audit.trail('m 1', USER_ID);
    expect(capturedUrl(mockFetch)).toContain('/v1/memories/m%201/audit');
  });
});

// ---------------------------------------------------------------------------
// Workspace contamination guard
// ---------------------------------------------------------------------------

describe('audit methods never emit workspace fields on the wire', () => {
  it('summary / recent / trail URLs carry only user_id (+ limit)', async () => {
    for (const exec of [
      () =>
        handle().audit.summary(USER_ID),
      () =>
        handle().audit.recent(USER_ID, 10),
      () =>
        handle().audit.trail('m1', USER_ID),
    ] as const) {
      mockFetch = installFetchMock();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          memory_id: 'm1', trail: [], version_count: 0,
          mutations: [], count: 0,
          total_versions: 0, active_versions: 0, superseded_versions: 0,
          total_claims: 0, by_mutation_type: {},
        }),
      );
      await exec();
      const url = capturedUrl(mockFetch);
      expect(url).not.toContain('workspace_id');
      expect(url).not.toContain('agent_id');
      expect(url).not.toContain('agent_scope');
    }
  });
});

function handle(): AtomicMemoryHandle {
  return createHandle();
}
