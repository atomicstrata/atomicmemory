/**
 * @file Unit tests for EntitiesClient.
 *
 * Tests each public method against a mocked fetch, verifying request
 * construction and response mapping (snake_case → camelCase).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntitiesClient } from '../client.js';

const API_URL = 'https://core.test';
const API_KEY = 'test-key';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
});

function makeClient() {
  return new EntitiesClient({ apiUrl: API_URL, apiKey: API_KEY, fetch: mockFetch });
}

// ---------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------

describe('profile', () => {
  it('maps snake_case response to camelCase EntityProfile', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      entity_type: 'user', entity_id: 'alice',
      profile: { summary: 'Alice is a PM.', preferences: ['p1'], instructions: [], open_commitments: [] },
      attributes: [], memory_count: 3, last_active: '2026-05-01T00:00:00Z', updated_at: null,
    }));
    const result = await makeClient().profile('alice');
    expect(result.entityId).toBe('alice');
    expect(result.profile?.summary).toBe('Alice is a PM.');
    expect(result.memoryCount).toBe(3);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/v1/entities/user/alice/profile`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('returns profile: null when server omits profile block', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      entity_type: 'user', entity_id: 'bob',
      profile: null, attributes: [], memory_count: 0, last_active: null, updated_at: null,
    }));
    const result = await makeClient().profile('bob');
    expect(result.profile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('paginates and maps entities list', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      entities: [{ entity_type: 'user', entity_id: 'alice', memory_count: 5, last_active: null }],
      total: 1, page: 1, page_size: 10,
    }));
    const result = await makeClient().list({ page: 1, pageSize: 10 });
    expect(result.total).toBe(1);
    expect(result.entities[0].entityId).toBe('alice');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('page=1');
    expect(url).toContain('page_size=10');
  });
});

// ---------------------------------------------------------------------------
// attributes
// ---------------------------------------------------------------------------

describe('attributes', () => {
  it('filters by attribute when provided', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      attributes: [{ entity: 'Alice', attribute: 'role', value: 'PM', type: 'string',
        source_memory_id: null, observed_at: '2026-05-01T00:00:00Z' }],
    }));
    const result = await makeClient().attributes('alice', { attribute: 'role' });
    expect(result[0].attribute).toBe('role');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('attribute=role');
  });
});

// ---------------------------------------------------------------------------
// get (entity detail)
// ---------------------------------------------------------------------------

describe('get', () => {
  it('maps entity detail with attributes, relations, and cards', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      entity_type: 'user', entity_id: 'alice', memory_count: 2,
      attributes: [{ entity: 'Alice', attribute: 'role', value: 'PM', type: 'string',
        source_memory_id: null, observed_at: '2026-05-01T00:00:00Z' }],
      relations: [], recent_cards: [], updated_at: null,
    }));
    const result = await makeClient().get('alice');
    expect(result.entityId).toBe('alice');
    expect(result.attributes[0].attribute).toBe('role');
    expect(result.relations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// patchSettings
// ---------------------------------------------------------------------------

describe('patchSettings', () => {
  it('maps entity_id from response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({
      entity_id: 'alice', extraction_prompt: 'Focus on healthcare.',
      memory_kinds: null, decay_enabled: true, updated_at: '2026-05-30T00:00:00Z',
    }));
    const result = await makeClient().patchSettings('alice', { extractionPrompt: 'Focus on healthcare.' });
    expect(result.entityId).toBe('alice');
    expect(result.extractionPrompt).toBe('Focus on healthcare.');
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe('request error handling', () => {
  it('throws on non-ok HTTP response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(makeClient().profile('nobody')).rejects.toThrow('404');
  });

  it('wraps network errors with context', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(makeClient().profile('alice')).rejects.toThrow('network error');
  });
});
