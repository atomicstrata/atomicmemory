/**
 * @file Tests for `StorageClient`'s transport-level error contract.
 *
 * Every fetch-impl rejection (DNS, ECONNREFUSED, AbortError, a
 * misconfigured fetch that throws synchronously) is wrapped as
 * `StorageClientError({errorCode:'network_error', status:0})` so
 * callers can branch on a stable error contract instead of
 * catching arbitrary `TypeError`s leaked from the fetch primitive.
 *
 * The non-2xx response path is intentionally NOT exercised here —
 * that lives in `client-error-mapping.test.ts`. This file covers
 * the case where fetch never returns a Response at all.
 */

import { describe, expect, it } from 'vitest';
import { ConcreteStorageClient } from '../client.js';
import { StorageClientError } from '../errors.js';

function makeRejectingClient(cause: unknown): ConcreteStorageClient {
  const impl: typeof fetch = async () => { throw cause; };
  return new ConcreteStorageClient({
    apiUrl: 'http://core.test', apiKey: 'k-secret', userId: 'u-1', fetch: impl,
  });
}

describe('StorageClient — transport-level fetch rejections wrap to network_error', () => {
  it('TypeError from fetch (e.g. DNS / fetch failed) → network_error', async () => {
    const client = makeRejectingClient(new TypeError('fetch failed'));
    await expect(client.capabilities())
      .rejects.toMatchObject({ errorCode: 'network_error', status: 0 });
  });

  it('AbortError → network_error', async () => {
    const cause = new Error('The user aborted a request.');
    cause.name = 'AbortError';
    const client = makeRejectingClient(cause);
    await expect(client.get({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'network_error', status: 0 });
  });

  it('non-Error throw (e.g. a string) is still wrapped, not propagated', async () => {
    const client = makeRejectingClient('something exploded');
    await expect(client.delete({ artifactId: 'a-1' }))
      .rejects.toMatchObject({ errorCode: 'network_error', status: 0 });
  });

  it('preserves the typed error class so callers can branch on `StorageClientError`', async () => {
    const client = makeRejectingClient(new Error('ECONNREFUSED 127.0.0.1:17350'));
    try {
      await client.head({ artifactId: 'a-1' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StorageClientError);
      expect((err as StorageClientError).errorCode).toBe('network_error');
      expect((err as StorageClientError).status).toBe(0);
      // The underlying cause's message is surfaced for ops triage,
      // but the typed envelope is the public contract.
      expect((err as StorageClientError).message).toContain('ECONNREFUSED');
    }
  });
});
