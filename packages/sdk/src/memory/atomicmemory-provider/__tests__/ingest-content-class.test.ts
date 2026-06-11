/**
 * @file Tests for `contentClass` forwarding on verbatim ingest.
 *
 * Verbatim ingest (`skip_extraction=true`) stores raw content, which a core
 * running the default `RAW_CONTENT_POLICY=reject` refuses unless the caller
 * stamps a non-raw `content_class`. The SDK forwards the caller's choice
 * verbatim and NEVER infers one: omitting it leaves the field off the wire so a
 * reject-policy core fails the ingest closed instead of the SDK mislabeling raw
 * content as safe. `contentClass` lives on `VerbatimIngest` only, so text /
 * messages modes cannot supply it at the type level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import { jsonResponse, installFetchMock } from '../../__tests__/shared/http-mocks';

const API_URL = 'https://test.atomicmemory.dev';
const USER = '00000000-0000-0000-0000-000000000abc';

const SUCCESSFUL_INGEST_BODY = {
  episode_id: 'e1',
  facts_extracted: 1,
  memories_stored: 1,
  memories_updated: 0,
  memories_deleted: 0,
  memories_skipped: 0,
  stored_memory_ids: ['m1'],
  updated_memory_ids: [],
  links_created: 0,
  composites_created: 0,
};

let mockFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  mockFetch = installFetchMock();
  mockFetch.mockResolvedValue(jsonResponse(SUCCESSFUL_INGEST_BODY));
});

function capturedBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('AtomicMemoryProvider.doIngest — contentClass forwarding', () => {
  it('forwards a stamped non-raw class to the wire', async () => {
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.ingest({
      mode: 'verbatim',
      content: 'Distilled summary line.',
      scope: { user: USER },
      contentClass: 'summary',
    });
    const body = capturedBody();
    expect(body.content_class).toBe('summary');
    expect(body.skip_extraction).toBe(true);
  });

  it('forwards an explicit raw choice unchanged (core enforces the policy)', async () => {
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.ingest({
      mode: 'verbatim',
      content: 'Verbatim transcript.',
      scope: { user: USER },
      contentClass: 'raw',
    });
    expect(capturedBody().content_class).toBe('raw');
  });

  it('omits content_class when the caller does not stamp one (fail closed)', async () => {
    const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
    await provider.ingest({
      mode: 'verbatim',
      content: 'Unclassified verbatim content.',
      scope: { user: USER },
    });
    expect('content_class' in capturedBody()).toBe(false);
  });
});
