/**
 * Unit tests for the S3-compatible raw-content adapter (Phase 3).
 *
 * The S3Client is mocked: each test injects a stub `send` that records
 * the command sent and returns a canned response. No network, no AWS
 * credentials needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { S3RawContentStore } from '../s3-store.js';

type CommandLog = { name: string; input: Record<string, unknown> }[];

function makeStubClient(handler: (name: string, input: Record<string, unknown>) => unknown): {
  client: S3Client;
  log: CommandLog;
} {
  const log: CommandLog = [];
  const send = vi.fn(async (cmd: unknown) => {
    const c = cmd as { constructor: { name: string }; input: Record<string, unknown> };
    log.push({ name: c.constructor.name, input: c.input });
    const out = handler(c.constructor.name, c.input);
    if (out instanceof Error) throw out;
    return out;
  });
  return { client: { send } as unknown as S3Client, log };
}

const BUCKET = 'test-bucket';
const COMMON_OPTIONS = {
  bucket: BUCKET,
  region: 'us-east-1',
  accessKeyId: 'test-id',
  secretAccessKey: 'test-secret',
};

describe('S3RawContentStore — happy path', () => {
  it('put sends PutObjectCommand with the right Bucket/Key/Body and returns the URI', async () => {
    const { client, log } = makeStubClient(() => ({}));
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const body = Buffer.from('hello s3', 'utf8');
    const stored = await store.put({ key: 'docs/u1/d1/blob.bin', body, contentType: 'text/plain' });
    expect(log).toHaveLength(1);
    expect(log[0].name).toBe('PutObjectCommand');
    expect(log[0].input).toMatchObject({
      Bucket: BUCKET,
      Key: 'docs/u1/d1/blob.bin',
      ContentType: 'text/plain',
    });
    expect(stored.storageUri).toBe(`s3://${BUCKET}/docs/u1/d1/blob.bin`);
    expect(stored.sizeBytes).toBe(body.length);
    expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('advertises immediate / location / delete capabilities', () => {
    // Phase-1 lifecycle contract: S3 PUT/GET are read-after-write
    // consistent, the URI is `s3://<bucket>/<key>` (path-addressed —
    // overwrites of the same key replace the bytes), and
    // `deleteSemantics: 'delete'` means the adapter issues
    // `DeleteObject` for the managed object. The bucket's versioning,
    // object-lock, retention, and replication policies are NOT part
    // of this assertion. Upload service and /limits read these.
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client: makeStubClient(() => ({})).client });
    expect(store.capabilities).toEqual({
      addressing: 'location',
      retrievalConsistency: 'immediate',
      deleteSemantics: 'delete',
      supportsHead: true,
      supportsGet: true,
    });
  });

  it("put returns status='stored' + empty providerMetadata for the immediate-provider path", async () => {
    const { client } = makeStubClient(() => ({}));
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const stored = await store.put({ key: 'lifecycle/sentinel.bin', body: Buffer.from('s') });
    expect(stored.status).toBe('stored');
    expect(stored.providerMetadata).toEqual({});
  });

  it('get reads via GetObjectCommand and surfaces metadata', async () => {
    const body = Buffer.from('payload');
    const { client } = makeStubClient((name) => {
      if (name === 'GetObjectCommand') {
        return {
          Body: { transformToByteArray: async () => new Uint8Array(body) },
          ContentLength: body.length,
          ContentType: 'application/octet-stream',
          ETag: '"etag-abc"',
        };
      }
      return {};
    });
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const got = await store.get(`s3://${BUCKET}/k1`);
    expect(Buffer.compare(got.body, body)).toBe(0);
    expect(got.metadata.contentType).toBe('application/octet-stream');
    expect(got.metadata.providerMetadata.etag).toBe('"etag-abc"');
  });

  it('head returns exists=true with metadata when the key is present', async () => {
    const { client } = makeStubClient((name) => {
      if (name === 'HeadObjectCommand') {
        return { ContentLength: 42, ContentType: 'application/pdf', VersionId: 'v1' };
      }
      return {};
    });
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const head = await store.head(`s3://${BUCKET}/exists.bin`);
    expect(head.exists).toBe(true);
    expect(head.metadata?.contentLength).toBe(42);
    expect(head.metadata?.providerMetadata.versionId).toBe('v1');
  });
});

describe('S3RawContentStore — delete idempotency + missing keys', () => {
  it('head returns exists=false for NotFound', async () => {
    const { client } = makeStubClient((name) => {
      if (name === 'HeadObjectCommand') {
        const e = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        return e;
      }
      return {};
    });
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const head = await store.head(`s3://${BUCKET}/missing.bin`);
    expect(head.exists).toBe(false);
    expect(head.metadata).toBeNull();
  });

  it('delete returns deleted=false when the key is missing (no DeleteObjectCommand sent)', async () => {
    const { client, log } = makeStubClient((name) => {
      if (name === 'HeadObjectCommand') {
        return Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      }
      return {};
    });
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const result = await store.delete(`s3://${BUCKET}/missing.bin`);
    expect(result.deleted).toBe(false);
    expect(result.semantics).toBe('deleted');
    expect(log.filter((c) => c.name === 'DeleteObjectCommand')).toHaveLength(0);
  });

  it('delete sends DeleteObjectCommand and returns deleted=true with semantics=deleted', async () => {
    const { client, log } = makeStubClient((name) => {
      if (name === 'HeadObjectCommand') return { ContentLength: 1 };
      return {};
    });
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    const result = await store.delete(`s3://${BUCKET}/present.bin`);
    expect(result.deleted).toBe(true);
    expect(result.semantics).toBe('deleted');
    expect(log.find((c) => c.name === 'DeleteObjectCommand')?.input).toMatchObject({
      Bucket: BUCKET,
      Key: 'present.bin',
    });
  });
});

describe('S3RawContentStore — URI parsing + construction guards', () => {
  it('rejects malformed s3 URIs', async () => {
    const { client } = makeStubClient(() => ({}));
    const store = new S3RawContentStore({ ...COMMON_OPTIONS, client });
    await expect(store.head('local-fs://x')).rejects.toThrow(/expected s3/);
    await expect(store.head('s3://just-bucket')).rejects.toThrow(/malformed/);
    await expect(store.head(`s3://${BUCKET}/`)).rejects.toThrow(/malformed/);
  });

  it('throws if bucket is missing at construction time', () => {
    expect(() => new S3RawContentStore({ ...COMMON_OPTIONS, bucket: '' as string })).toThrow(/bucket/);
  });

  it('throws if region is missing at construction time', () => {
    expect(() => new S3RawContentStore({ ...COMMON_OPTIONS, region: '' as string })).toThrow(/region/);
  });
});

// Quiet the SDK's "no credentials" warning when we don't inject a client.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// Suppress unused-import "as never used" warnings from the SDK names
// imported only for type-driven assertions in the test text above.
void DeleteObjectCommand;
void GetObjectCommand;
void HeadObjectCommand;
void PutObjectCommand;
