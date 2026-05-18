/**
 * @file Tests for caller-supplied `metadata` forwarding through
 * `AtomicMemoryProvider.doIngest`.
 *
 * Background. `IngestInput` (`src/memory/types.ts:63`) has declared
 * `metadata?: Record<string, unknown>` on `IngestBase` since the
 * type was introduced — every variant (`text`, `messages`,
 * `verbatim`) inherits the field. But the provider's HTTP body
 * builder used to drop the value: `client.ingest({ mode: 'verbatim',
 * metadata })` typechecked but the JSONB column on the resulting
 * memory row stayed empty.
 *
 * `atomicmemory-core` PR #51 added the wire path that honors
 * caller-supplied metadata on `/v1/memories/ingest/quick` (with
 * `skip_extraction=true` and no workspace context). This suite
 * verifies the SDK provider now forwards the field through to the
 * HTTP body so end-to-end persistence actually works.
 *
 * Coverage:
 *  - happy path: metadata present and non-empty → wire body has
 *    `metadata` deep-equal to the input
 *  - omission: metadata absent OR `{}` → no `metadata` key on the
 *    wire (so non-metadata callers don't emit a stray empty object)
 *  - text / messages modes: the field is
 *    inherited from `IngestBase` for type ergonomics, but core
 *    rejects metadata with 400 on every non-verbatim branch.
 *    Forwarding it on those modes would turn a previously-passing
 *    call (silent drop) into a hard 400. The provider gates the
 *    forward at runtime so existing text/messages callers that
 *    typed metadata are not broken. Type-level narrowing
 *    (removing metadata from IngestBase) would be an explicit
 *    breaking change for a separate PR; this PR keeps the public
 *    surface and just enforces the safe runtime contract.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AtomicMemoryProvider } from '../atomicmemory-provider';
import {
  jsonResponse,
  installFetchMock,
} from '../../__tests__/shared/http-mocks';

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

describe('AtomicMemoryProvider.doIngest — metadata forwarding', () => {
  describe('verbatim mode (the route core accepts metadata on)', () => {
    it('forwards a non-empty metadata object to the HTTP body unchanged', async () => {
      const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
      const metadata = {
        event: 'task_completed',
        session_id: 'session-abc',
        nested: { task_id: 'task-1', tool_count: 3 },
      };
      await provider.ingest({
        mode: 'verbatim',
        content: 'Verbatim payload with caller metadata.',
        scope: { user: USER },
        metadata,
      });
      const body = capturedBody();
      expect(body.metadata).toEqual(metadata);
      expect(body.skip_extraction).toBe(true);
    });

    it('omits the metadata key entirely when input.metadata is absent', async () => {
      const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
      await provider.ingest({
        mode: 'verbatim',
        content: 'No-metadata verbatim ingest.',
        scope: { user: USER },
      });
      const body = capturedBody();
      expect('metadata' in body).toBe(false);
    });

    it('omits the metadata key when input.metadata is an empty object', async () => {
      const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
      await provider.ingest({
        mode: 'verbatim',
        content: 'Empty-object metadata should not emit metadata field.',
        scope: { user: USER },
        metadata: {},
      });
      const body = capturedBody();
      expect('metadata' in body).toBe(false);
    });
  });

  describe('text mode (gate prevents core 400 regression)', () => {
    it('does NOT forward metadata even when caller supplies it', async () => {
      // Forwarding metadata on text mode would turn a previously
      // accepted call into a hard 400 from core. Until type-level
      // narrowing moves `metadata` off IngestBase, the provider must
      // runtime-gate the forward to verbatim only.
      const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
      await provider.ingest({
        mode: 'text',
        content: 'Some text.',
        scope: { user: USER },
        metadata: { event: 'note', schema_version: 1 },
      });
      const body = capturedBody();
      expect('metadata' in body).toBe(false);
      expect(body.skip_extraction).toBeUndefined();
    });
  });

  describe('messages mode (gate prevents core 400 regression)', () => {
    it('does NOT forward metadata even when caller supplies it', async () => {
      const provider = new AtomicMemoryProvider({ apiUrl: API_URL });
      await provider.ingest({
        mode: 'messages',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        scope: { user: USER },
        metadata: { event: 'chat', session_id: 's-99' },
      });
      const body = capturedBody();
      expect('metadata' in body).toBe(false);
    });
  });
});
