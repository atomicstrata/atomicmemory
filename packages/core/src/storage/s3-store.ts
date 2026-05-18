/**
 * S3-compatible adapter for `RawContentStore`.
 *
 * Backed by `@aws-sdk/client-s3`. Works against AWS S3 (no `endpoint`
 * override) and against S3-compatible providers like Cloudflare R2 or
 * MinIO when an explicit `endpoint` URL is supplied. The adapter is
 * stateless across calls — one `S3Client` is shared per instance.
 *
 * Storage URI shape: `s3://<bucket>/<key>`. The bucket carried in the
 * URI is what the adapter writes/reads; if a future operator changes
 * `RAW_STORAGE_BUCKET`, the URIs persisted on existing rows still point
 * at the original bucket, which is the correct semantics for moving the
 * default bucket without orphaning historical blobs.
 *
 * Idempotent delete: S3 `DeleteObject` is itself idempotent (no error
 * on missing key); `head` translates `NotFound`/`NoSuchKey` to
 * `{exists: false}` rather than throwing.
 */

import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  RawStorageUriError,
  type PutRawContentInput,
  type RawContentDeleteResult,
  type RawContentGetResult,
  type RawContentHeadResult,
  type RawContentHints,
  type RawContentMetadata,
  type RawContentStore,
  type RawContentStoreCapabilities,
  type StoredRawContent,
} from './raw-content-store.js';

const PROVIDER = 's3' as const;
const URI_PREFIX = 's3://';

/**
 * S3 is path-addressed (`s3://<bucket>/<key>` — overwrites of the same
 * key replace the bytes the URI resolves to), bytes are retrievable
 * the moment `PutObject` returns (read-after-write consistent), and
 * `DeleteObject` issues the provider's removal operation for the
 * managed object. AtomicMemory does not assert what the bucket's
 * versioning, object-lock, retention, or replication policies do
 * with that delete call — those live outside the adapter contract.
 */
const CAPABILITIES: RawContentStoreCapabilities = Object.freeze({
  addressing: 'location',
  retrievalConsistency: 'immediate',
  deleteSemantics: 'delete',
  supportsHead: true,
  supportsGet: true,
});

export interface S3RawContentStoreOptions {
  /** Default bucket new puts write to. Existing URIs honor their own bucket. */
  bucket: string;
  region: string;
  /** Custom endpoint URL for R2/MinIO/etc. Omit for AWS S3 default. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional pre-built client — primarily an injection seam for tests. */
  client?: S3Client;
}

export class S3RawContentStore implements RawContentStore {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3RawContentStoreOptions) {
    if (!options.bucket) throw new Error('S3RawContentStore: bucket is required');
    if (!options.region) throw new Error('S3RawContentStore: region is required');
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client(buildClientConfig(options));
  }

  async put(input: PutRawContentInput): Promise<StoredRawContent> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return {
      storageUri: `${URI_PREFIX}${this.bucket}/${input.key}`,
      storageProvider: PROVIDER,
      contentHash: sha256Hex(input.body),
      sizeBytes: input.body.length,
      status: 'stored',
      providerMetadata: {},
    };
  }

  async get(storageUri: string): Promise<RawContentGetResult> {
    const { bucket, key } = parseUri(storageUri);
    const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await collectBody(result.Body);
    return {
      body,
      metadata: {
        contentLength: result.ContentLength ?? body.length,
        contentType: result.ContentType ?? null,
        contentHash: sha256Hex(body),
        providerMetadata: extractProviderMetadata(result),
      },
    };
  }

  async head(storageUri: string, _hints?: RawContentHints): Promise<RawContentHeadResult> {
    const { bucket, key } = parseUri(storageUri);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        exists: true,
        metadata: {
          contentLength: result.ContentLength ?? 0,
          contentType: result.ContentType ?? null,
          contentHash: null,
          providerMetadata: extractProviderMetadata(result),
        },
      };
    } catch (err) {
      if (isNotFound(err)) return { exists: false, metadata: null };
      throw err;
    }
  }

  async delete(storageUri: string, _hints?: RawContentHints): Promise<RawContentDeleteResult> {
    const { bucket, key } = parseUri(storageUri);
    try {
      // Pre-check existence so the response distinguishes "we deleted
      // something" from "it was already gone". S3's DeleteObject would
      // otherwise return success in both cases.
      const present = await this.head(storageUri);
      if (!present.exists) return { deleted: false, semantics: 'deleted' };
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { deleted: true, semantics: 'deleted' };
    } catch (err) {
      if (isNotFound(err)) return { deleted: false, semantics: 'deleted' };
      throw err;
    }
  }
}

function buildClientConfig(options: S3RawContentStoreOptions): S3ClientConfig {
  const cfg: S3ClientConfig = {
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  };
  if (options.endpoint) {
    cfg.endpoint = options.endpoint;
    // R2 / MinIO require path-style addressing; AWS S3 supports it too.
    cfg.forcePathStyle = true;
  }
  return cfg;
}

function parseUri(storageUri: string): { bucket: string; key: string } {
  if (!storageUri.startsWith(URI_PREFIX)) {
    throw new RawStorageUriError(`expected s3:// URI, got: ${storageUri}`);
  }
  const trimmed = storageUri.slice(URI_PREFIX.length);
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new RawStorageUriError(`malformed s3 URI: ${storageUri}`);
  }
  return { bucket: trimmed.slice(0, slash), key: trimmed.slice(slash + 1) };
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface BodyLike {
  transformToByteArray?: () => Promise<Uint8Array>;
}

async function collectBody(body: unknown): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  const candidate = body as BodyLike;
  if (typeof candidate.transformToByteArray === 'function') {
    return Buffer.from(await candidate.transformToByteArray());
  }
  // Fallback for already-buffered bodies (mocks/tests).
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new Error('S3 GetObject body shape not recognized');
}

function extractProviderMetadata(result: {
  ETag?: string;
  VersionId?: string;
  LastModified?: Date;
}): RawContentMetadata['providerMetadata'] {
  const meta: RawContentMetadata['providerMetadata'] = {};
  if (result.ETag) meta.etag = result.ETag;
  if (result.VersionId) meta.versionId = result.VersionId;
  if (result.LastModified) meta.lastModified = result.LastModified.toISOString();
  return meta;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.Code === 'NoSuchKey'
    || e.$metadata?.httpStatusCode === 404;
}
