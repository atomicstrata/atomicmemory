/**
 * @file Hindsight Provider Contract Tests
 *
 * Covers provider behavior that depends on Hindsight's documented wire
 * contract: health status, strict response mapping, direct operation lookup,
 * and contextual retain failures.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HindsightProvider } from '../hindsight-provider';
import type { HindsightOperationsHandle } from '../types';
import type { Scope, SearchRequest } from '../../types';
import { MemoryProviderError } from '../../errors';
import {
  errorResponse,
  installFetchMock,
  jsonResponse,
} from '../../__tests__/shared/http-mocks';

const API_URL = 'https://api.hindsight.vectorize.io';
const VALID_SCOPE: Scope = { user: 'user-1' };

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = installFetchMock();
});

describe('health', () => {
  it('returns ok true and maps version from a 200 health response', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', version: '0.6.1' }),
    );

    const health = await provider.health();

    expect(requestUrl()).toBe(`${API_URL}/health`);
    expect(health.ok).toBe(true);
    expect(health.version).toBe('0.6.1');
  });

  it('returns ok false when health responds with an error status', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(errorResponse(500));

    const health = await provider.health();

    expect(health.ok).toBe(false);
  });
});

describe('strict response mapping', () => {
  it('throws when a memory response omits every documented timestamp field', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [{ id: 'm1', text: 'No date' }] }),
    );

    await expect(provider.search(searchRequest())).rejects.toThrow(
      /missing timestamp field/,
    );
  });

  it('throws when a recall response omits the documented results array', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(jsonResponse({ items: [] }));

    await expect(provider.search(searchRequest())).rejects.toThrow(
      /missing results array/,
    );
  });
});

describe('operation lookup', () => {
  it('uses Hindsight direct operation status endpoint', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ operation_id: 'op-1', status: 'processing' }),
    );
    const operations = provider.getExtension<HindsightOperationsHandle>(
      'hindsight.operations',
    );

    const operation = await operations?.get(VALID_SCOPE, 'op-1');

    expect(requestUrl()).toBe(
      `${API_URL}/v1/default/banks/user-1/operations/op-1`,
    );
    expect(operation?.status).toBe('processing');
  });
});

describe('retain failure', () => {
  it('throws a provider error with retain response context', async () => {
    const provider = createProvider();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        operation_id: 'op-failed',
        items_count: 2,
        async: true,
      }),
    );

    const ingest = provider.ingest(textInput());

    await expect(ingest).rejects.toThrow(
      /operation_id=op-failed, items_count=2, async=true/,
    );
    await expect(ingest).rejects.toBeInstanceOf(MemoryProviderError);
  });
});

function createProvider(): HindsightProvider {
  return new HindsightProvider({ apiUrl: API_URL });
}

function searchRequest(): SearchRequest {
  return { query: 'python', scope: VALID_SCOPE };
}

function textInput() {
  return {
    mode: 'text' as const,
    content: 'Alice likes Python',
    scope: VALID_SCOPE,
  };
}

function requestUrl(): string {
  return String(mockFetch.mock.calls[0][0]);
}
