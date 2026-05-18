/**
 * @file Mocked-fetch tests for the request side of `StorageClient`.
 *
 * Covers wire-format correctness on the outbound path: pointer +
 * managed body shaping, content-length discipline, route
 * construction, the `?force` non-rejection, and the
 * AtomicMemoryClient wiring guard for `verify`.
 *
 * Response-mapping tests (snake→camel, closed-enum validation,
 * HEAD) live in `client-response-mapping.test.ts`. Typed error
 * mapping lives in `client-error-mapping.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  coreResponseBody,
  makeClient,
  mockFetch,
} from './client-test-helpers.js';

describe('StorageClient — request shape', () => {
  it('put(pointer) sends a JSON body with snake_case wire fields', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 201,
      body: coreResponseBody({
        artifact_id: '00000000-0000-4000-8000-000000000001', mode: 'pointer',
      }),
    }));
    const client = makeClient(impl);
    await client.put({
      mode: 'pointer',
      uri: 'https://e/a',
      contentType: 'text/plain',
      sizeBytes: 10,
      metadata: { source: 'drive' },
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://core.test/v1/storage/artifacts');
    expect(calls[0].url).not.toMatch(/user_id/);
    expect(calls[0].headers['authorization']).toBe('Bearer k-secret');
    expect(calls[0].headers['x-atomicmemory-user-id']).toBe('u-1');
    expect(calls[0].headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(calls[0].body as string) as Record<string, unknown>;
    expect(parsed).toEqual({
      mode: 'pointer',
      uri: 'https://e/a',
      content_type: 'text/plain',
      size_bytes: 10,
      metadata: { source: 'drive' },
    });
  });

  it('put(managed) sends raw bytes with Content-Length and the metadata header (base64 JSON)', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 201,
      body: coreResponseBody({
        artifact_id: '00000000-0000-4000-8000-000000000002', mode: 'managed', uri: null,
      }),
    }));
    const client = makeClient(impl);
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await client.put({
      mode: 'managed',
      body,
      contentType: 'application/octet-stream',
      discloseContentHash: true,
      metadata: { filename: 'a.bin' },
    });
    expect(calls[0].url).toBe(
      'http://core.test/v1/storage/artifacts?mode=managed&disclose_content_hash=true',
    );
    expect(calls[0].url).not.toMatch(/user_id/);
    expect(calls[0].headers['x-atomicmemory-user-id']).toBe('u-1');
    expect(calls[0].headers['authorization']).toBe('Bearer k-secret');
    expect(calls[0].headers['content-length']).toBe('5');
    const headerValue = calls[0].headers['x-atomicmemory-metadata'];
    expect(headerValue).toBeDefined();
    expect(JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'))).toEqual({ filename: 'a.bin' });
  });

  it('put(managed) sends ONLY the bytes the caller selected, even when body is a sliced Uint8Array', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 201,
      body: coreResponseBody({ artifact_id: 'a-2', mode: 'managed', uri: null }),
    }));
    const client = makeClient(impl);
    const backing = new Uint8Array([0xff, 0xff, 1, 2, 3, 0xff, 0xff]);
    // `subarray` is a VIEW: same ArrayBuffer, offset=2, length=3.
    // Without correct view handling the wire would carry the entire
    // 7-byte backing array (including the surrounding 0xff bytes)
    // and disagree with Content-Length=3.
    const view = backing.subarray(2, 5);
    await client.put({
      mode: 'managed',
      body: view,
      contentType: 'application/octet-stream',
    });
    expect(calls[0].headers['content-length']).toBe('3');
    const sent = calls[0].body as Uint8Array;
    expect(sent.byteLength).toBe(3);
    expect(Array.from(sent)).toEqual([1, 2, 3]);
    expect(Array.from(sent).every((b) => b !== 0xff)).toBe(true);
  });

  it('put(managed) handles a Node Buffer subarray view correctly (offset + length preserved)', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 201,
      body: coreResponseBody({ artifact_id: 'a-3', mode: 'managed', uri: null }),
    }));
    const client = makeClient(impl);
    const backing = Buffer.from([0xff, 0xff, 0xff, 9, 9, 9, 0xff]);
    const view = backing.subarray(3, 6);
    await client.put({
      mode: 'managed',
      body: view,
      contentType: 'application/octet-stream',
    });
    expect(calls[0].headers['content-length']).toBe('3');
    const sent = calls[0].body as Uint8Array;
    expect(sent.byteLength).toBe(3);
    expect(Array.from(sent)).toEqual([9, 9, 9]);
  });

  it('rejects streams / ReadableStream bodies with `streaming_body_not_supported`', async () => {
    const { impl } = mockFetch(() => ({ status: 201, body: {} }));
    const client = makeClient(impl);
    await expect(
      client.put({
        mode: 'managed',
        body: new ReadableStream() as unknown as Uint8Array,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ errorCode: 'streaming_body_not_supported' });
  });

  it('rejects Blob bodies in v1 even when callers bypass the static type (must be converted to ArrayBuffer first)', async () => {
    const { impl } = mockFetch(() => ({ status: 201, body: {} }));
    const client = makeClient(impl);
    const blob = new Blob([new Uint8Array([1, 2])]);
    await expect(
      client.put({
        mode: 'managed',
        // Blob is intentionally NOT part of `PutManagedInput.body`'s
        // static type; the runtime check guards untyped JS callers.
        body: blob as unknown as Uint8Array,
        contentType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ errorCode: 'unsupported_body_type' });
  });
});

describe('StorageClient — route routing', () => {
  it('get(ref) hits /:id, getContent(ref) hits /:id/content', async () => {
    const { impl, calls } = mockFetch((req) => {
      if (req.url.endsWith('/content')) return { status: 200, body: 'BYTES', headers: { 'content-type': 'application/octet-stream' } };
      return { status: 200, body: coreResponseBody({ artifact_id: 'a-1', uri: 'https://x' }) };
    });
    const client = makeClient(impl);
    await client.get({ artifactId: 'a-1' });
    await client.getContent({ artifactId: 'a-1' });
    expect(calls[0].url).toBe('http://core.test/v1/storage/artifacts/a-1');
    expect(calls[1].url).toBe('http://core.test/v1/storage/artifacts/a-1/content');
    for (const c of calls) {
      expect(c.url).not.toMatch(/user_id/);
      expect(c.headers['x-atomicmemory-user-id']).toBe('u-1');
    }
  });

  it('delete serializes `policy` and omits it when absent; never sends `force` or `user_id`', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 200,
      body: { artifact_id: 'a-1', status: 'deleted', cascaded_document_ids: ['d-1'] },
    }));
    const client = makeClient(impl);
    await client.delete({ artifactId: 'a-1' });
    await client.delete({ artifactId: 'a-1' }, { policy: 'with_documents' });
    expect(calls[0].url).toBe('http://core.test/v1/storage/artifacts/a-1');
    expect(calls[1].url).toBe('http://core.test/v1/storage/artifacts/a-1?policy=with_documents');
    for (const c of calls) {
      expect(c.url).not.toMatch(/force/);
      expect(c.url).not.toMatch(/user_id/);
      expect(c.headers['x-atomicmemory-user-id']).toBe('u-1');
    }
  });
});

describe('AtomicMemoryClient wiring guard', () => {
  it('verify() does not serialize options on the wire (v1 server ignores them)', async () => {
    const { impl, calls } = mockFetch(() => ({ status: 200, body: { kind: 'unsupported', reason: 'pointer' } }));
    const client = makeClient(impl);
    await client.verify({ artifactId: 'a-1' }, { mode: 'hash_verify' });
    expect(calls[0].url).toBe('http://core.test/v1/storage/artifacts/a-1/verify');
    expect(calls[0].url).not.toMatch(/user_id/);
    expect(calls[0].headers['x-atomicmemory-user-id']).toBe('u-1');
    expect(calls[0].body).toBeUndefined();
    vi.fn();
  });
});
