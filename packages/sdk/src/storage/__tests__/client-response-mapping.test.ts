/**
 * @file Mocked-fetch tests for the response side of `StorageClient`:
 * `mapStoredArtifact`, `mapDeleteResult`, and the HEAD-header
 * projection. Each mapper must:
 *
 *   - translate every documented snake_case wire field to its
 *     camelCase SDK counterpart,
 *   - validate closed-enum fields (`mode`, `status`,
 *     `content_encoding`) against the SDK's own enum set,
 *   - require non-empty snake_case `artifact_id` (no camelCase
 *     alias polyfill — the wire is snake_case),
 *   - throw `StorageClientError({errorCode:'invalid_storage_response'})`
 *     on missing / wrong-type / out-of-enum values.
 *
 * Request-shape tests live in `client-request-shape.test.ts`;
 * typed error mapping in `client-error-mapping.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  coreResponseBody,
  makeClient,
  mockFetch,
} from './client-test-helpers.js';

describe('StorageClient — mapStoredArtifact happy path', () => {
  it('translates ALL snake_case wire fields to camelCase', async () => {
    const { impl } = mockFetch(() => ({
      status: 201,
      body: {
        artifact_id: '11111111-2222-4333-8444-555555555555',
        provider: 'local_fs',
        mode: 'managed',
        uri: 'local-fs://s/abc/x.bin',
        status: 'stored',
        size_bytes: 1234,
        content_type: 'application/pdf',
        content_hash: 'a'.repeat(64),
        content_encoding: 'aes_gcm',
        identifiers: { local_fs_key: 'k' },
        lifecycle: { availability: 'immediate', deleteSemantics: 'delete' },
        metadata: { source: 'drive' },
        provider_details: { region: 'us-east-1' },
        created_at: '2026-05-12T00:00:00.000Z',
        updated_at: '2026-05-12T00:00:01.000Z',
      },
    }));
    const client = makeClient(impl);
    const result = await client.put({
      mode: 'managed', body: new Uint8Array([1]), contentType: 'application/pdf',
    });
    expect(result).toEqual({
      artifactId: '11111111-2222-4333-8444-555555555555',
      provider: 'local_fs',
      mode: 'managed',
      uri: 'local-fs://s/abc/x.bin',
      status: 'stored',
      sizeBytes: 1234,
      contentType: 'application/pdf',
      contentHash: 'a'.repeat(64),
      contentEncoding: 'aes_gcm',
      identifiers: { local_fs_key: 'k' },
      lifecycle: { availability: 'immediate', deleteSemantics: 'delete' },
      metadata: { source: 'drive' },
      providerDetails: { region: 'us-east-1' },
      createdAt: '2026-05-12T00:00:00.000Z',
      updatedAt: '2026-05-12T00:00:01.000Z',
    });
    for (const k of ['size_bytes', 'content_type', 'content_hash', 'content_encoding',
                     'provider_details', 'created_at', 'updated_at']) {
      expect(result).not.toHaveProperty(k);
    }
  });

  it('maps snake_case `artifact_id` to camelCase `artifactId` on put/get', async () => {
    const { impl } = mockFetch(() => ({
      status: 201,
      body: coreResponseBody({
        artifact_id: '11111111-2222-4333-8444-555555555555',
        provider: 'local_fs', mode: 'pointer', uri: 'https://e/a',
      }),
    }));
    const client = makeClient(impl);
    const result = await client.put({
      mode: 'pointer', uri: 'https://e/a', contentType: 'text/plain',
    });
    expect(result.artifactId).toBe('11111111-2222-4333-8444-555555555555');
  });
});

describe('StorageClient — mapStoredArtifact validation', () => {
  it('throws invalid_storage_response when artifact_id is missing', async () => {
    const body = coreResponseBody();
    delete (body as { artifact_id?: unknown }).artifact_id;
    const { impl } = mockFetch(() => ({ status: 201, body }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when artifact_id is the empty string', async () => {
    const { impl } = mockFetch(() => ({
      status: 201, body: coreResponseBody({ artifact_id: '' }),
    }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('does NOT accept a camelCase `artifactId` alias on the wire (snake_case only)', async () => {
    const body = coreResponseBody();
    delete (body as { artifact_id?: unknown }).artifact_id;
    (body as Record<string, unknown>).artifactId = 'a-camel';
    const { impl } = mockFetch(() => ({ status: 201, body }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when `mode` is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 201, body: coreResponseBody({ mode: 'archived' }),
    }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when `status` is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 201, body: coreResponseBody({ status: 'invented' }),
    }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when `content_encoding` is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 201, body: coreResponseBody({ content_encoding: 'gzip' }),
    }));
    const client = makeClient(impl);
    await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it.each(['provider', 'created_at', 'updated_at'])(
    'throws invalid_storage_response when required field `%s` is missing',
    async (field) => {
      const body = coreResponseBody();
      delete (body as Record<string, unknown>)[field];
      const { impl } = mockFetch(() => ({ status: 201, body }));
      const client = makeClient(impl);
      await expect(client.put({ mode: 'pointer', uri: 'https://e/a', contentType: 't' }))
        .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
    },
  );
});

describe('StorageClient — mapDeleteResult', () => {
  it('maps cascaded_document_ids -> cascadedDocumentIds on delete', async () => {
    const { impl } = mockFetch(() => ({
      status: 200,
      body: { artifact_id: 'a-1', status: 'deleted', cascaded_document_ids: ['d-1', 'd-2'] },
    }));
    const client = makeClient(impl);
    const result = await client.delete({ artifactId: 'a-1' });
    expect(result.artifactId).toBe('a-1');
    expect(result.status).toBe('deleted');
    expect(result.cascadedDocumentIds).toEqual(['d-1', 'd-2']);
  });

  it('omits cascadedDocumentIds when the wire envelope has no `cascaded_document_ids`', async () => {
    const { impl } = mockFetch(() => ({
      status: 200, body: { artifact_id: 'a-1', status: 'deleted' },
    }));
    const client = makeClient(impl);
    const result = await client.delete({ artifactId: 'a-1' });
    expect(result).toEqual({ artifactId: 'a-1', status: 'deleted' });
    expect(result).not.toHaveProperty('cascadedDocumentIds');
  });

  it('throws invalid_storage_response when delete response is missing artifact_id', async () => {
    const { impl } = mockFetch(() => ({ status: 200, body: { status: 'deleted' } }));
    const client = makeClient(impl);
    await expect(client.delete({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when delete response has empty artifact_id', async () => {
    const { impl } = mockFetch(() => ({
      status: 200, body: { artifact_id: '', status: 'deleted' },
    }));
    const client = makeClient(impl);
    await expect(client.delete({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('does NOT accept a camelCase `artifactId` alias on the delete wire envelope', async () => {
    const { impl } = mockFetch(() => ({
      status: 200, body: { artifactId: 'a-camel', status: 'deleted' },
    }));
    const client = makeClient(impl);
    await expect(client.delete({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });

  it('throws invalid_storage_response when delete `status` is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 200, body: { artifact_id: 'a-1', status: 'made-up-status' },
    }));
    const client = makeClient(impl);
    await expect(client.delete({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_storage_response' });
  });
});

describe('StorageClient — head() header projection', () => {
  it('reads X-AtomicMemory-* response headers and emits camelCase fields', async () => {
    const { impl } = mockFetch(() => ({
      status: 200,
      headers: {
        'x-atomicmemory-artifact-id': 'a-1',
        'x-atomicmemory-storage-mode': 'managed',
        'x-atomicmemory-storage-status': 'stored',
        'x-atomicmemory-provider': 'local_fs',
        'content-length': '42',
        'content-type': 'application/pdf',
      },
    }));
    const client = makeClient(impl);
    const head = await client.head({ artifactId: 'a-1' });
    expect(head.artifactId).toBe('a-1');
    expect(head.mode).toBe('managed');
    expect(head.status).toBe('stored');
    expect(head.sizeBytes).toBe(42);
    expect(head.contentType).toBe('application/pdf');
    expect(head).not.toHaveProperty('size_bytes');
    expect(head).not.toHaveProperty('content_type');
  });

  it('throws invalid_head_response when storage-mode is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 200,
      headers: {
        'x-atomicmemory-artifact-id': 'a-1',
        'x-atomicmemory-storage-mode': 'bogus-mode',
        'x-atomicmemory-storage-status': 'stored',
        'x-atomicmemory-provider': 'local_fs',
      },
    }));
    const client = makeClient(impl);
    await expect(client.head({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_head_response' });
  });

  it('throws invalid_head_response when storage-status is not in the closed enum', async () => {
    const { impl } = mockFetch(() => ({
      status: 200,
      headers: {
        'x-atomicmemory-artifact-id': 'a-1',
        'x-atomicmemory-storage-mode': 'managed',
        'x-atomicmemory-storage-status': 'made-up',
        'x-atomicmemory-provider': 'local_fs',
      },
    }));
    const client = makeClient(impl);
    await expect(client.head({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'invalid_head_response' });
  });
});
