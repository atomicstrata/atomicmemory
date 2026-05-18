/**
 * @file Mocked-fetch tests for `StorageClient`'s typed error
 * surface and the capabilities probe. Every non-2xx envelope core
 * emits is exercised here so the SDK error class hierarchy stays
 * in sync with the wire contract.
 *
 * Request-shape tests live in `client-request-shape.test.ts`;
 * response-mapping tests in `client-response-mapping.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ArtifactInUseError,
  ArtifactNotFoundError,
  FilecoinDirectStorageNotSupportedError,
  PointerContentNotManagedError,
  StorageClientError,
} from '../errors.js';
import { makeClient, mockFetch } from './client-test-helpers.js';

describe('StorageClient — typed error mapping', () => {
  it('409 artifact_in_use → ArtifactInUseError preserves the artifact id and referencedByDocumentCount', async () => {
    const { impl } = mockFetch(() => ({
      status: 409,
      body: { error_code: 'artifact_in_use', error: 'referenced', referenced_by_document_count: 3 },
    }));
    const client = makeClient(impl);
    try {
      await client.delete({ artifactId: 'a-1' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactInUseError);
      expect((err as ArtifactInUseError).artifactId).toBe('a-1');
      expect((err as ArtifactInUseError).referencedByDocumentCount).toBe(3);
    }
  });

  it('409 pointer_content_not_managed → PointerContentNotManagedError preserves the artifact id and URI', async () => {
    const { impl } = mockFetch(() => ({
      status: 409,
      body: { error_code: 'pointer_content_not_managed', uri: 'https://e/x' },
    }));
    const client = makeClient(impl);
    try {
      await client.getContent({ artifactId: 'a-2' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PointerContentNotManagedError);
      expect((err as PointerContentNotManagedError).artifactId).toBe('a-2');
      expect((err as PointerContentNotManagedError).uri).toBe('https://e/x');
    }
  });

  it('404 artifact_not_found → ArtifactNotFoundError preserves the artifact id the caller asked for', async () => {
    const { impl } = mockFetch(() => ({ status: 404, body: { error_code: 'artifact_not_found' } }));
    const client = makeClient(impl);
    try {
      await client.get({ artifactId: 'a-404' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactNotFoundError);
      expect((err as ArtifactNotFoundError).artifactId).toBe('a-404');
    }
  });

  it('501 filecoin_direct_storage_not_yet_supported → FilecoinDirectStorageNotSupportedError', async () => {
    const { impl } = mockFetch(() => ({
      status: 501,
      body: { error_code: 'filecoin_direct_storage_not_yet_supported' },
    }));
    const client = makeClient(impl);
    await expect(
      client.put({
        mode: 'managed',
        body: new Uint8Array([1]),
        contentType: 'application/octet-stream',
      }),
    ).rejects.toBeInstanceOf(FilecoinDirectStorageNotSupportedError);
  });

  it('unknown envelopes / non-2xx fall back to a generic StorageClientError', async () => {
    const { impl } = mockFetch(() => ({ status: 502, body: 'gateway error' }));
    const client = makeClient(impl);
    try {
      await client.get({ artifactId: 'a-1' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageClientError);
      expect((err as StorageClientError).status).toBe(502);
    }
  });
});

describe('StorageClient — capabilities', () => {
  it('parses the JSON response and sends Authorization + X-AtomicMemory-User-Id on the request', async () => {
    const { impl, calls } = mockFetch(() => ({
      status: 200,
      body: { provider: 'local_fs', supportsDirectUpload: true, supportsContentHash: true },
    }));
    const client = makeClient(impl);
    const caps = await client.capabilities();
    expect(caps.provider).toBe('local_fs');
    // Locks in the universal `request` helper behavior — every
    // storage call (including capabilities, which has no artifact
    // context) carries the auth + owner-scope headers and never
    // leaks `user_id` into the URL.
    expect(calls[0].headers['authorization']).toBe('Bearer k-secret');
    expect(calls[0].headers['x-atomicmemory-user-id']).toBe('u-1');
    expect(calls[0].url).not.toMatch(/user_id/);
  });
});
