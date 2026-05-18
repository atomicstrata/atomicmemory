/**
 * `local_fs` adapter for `RawContentStore`.
 *
 * Stores blobs on the local filesystem under a configured root. Used for
 * development and single-node test deployments — production setups
 * configure the S3 adapter instead.
 *
 * Storage URI shape: `local-fs://<adapter-relative-key>`. The key is the
 * same string the caller passed to `put()`; the absolute filesystem path
 * is reconstructed by joining `root + key`. We never persist the absolute
 * path on the wire so the same DB row stays portable when the root moves.
 *
 * Atomicity: writes go through a `<key>.tmp.<nonce>` sibling and are
 * promoted with `fs.rename`, so a crash mid-write never leaves a
 * partial blob at the final key. `delete` is idempotent — `ENOENT`
 * surfaces as `{ deleted: false }` rather than an error.
 *
 * Path safety: every adapter-relative key resolves through `path.resolve`
 * and is rejected if it escapes `root`. That keeps a malicious or
 * mistaken `..`-laden key from writing/reading outside the configured
 * sandbox.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  RawStorageUriError,
  type PutRawContentInput,
  type RawContentDeleteResult,
  type RawContentGetResult,
  type RawContentHeadResult,
  type RawContentHints,
  type RawContentStore,
  type RawContentStoreCapabilities,
  type StoredRawContent,
} from './raw-content-store.js';

const PROVIDER = 'local_fs' as const;
const URI_PREFIX = 'local-fs://';

/**
 * `local_fs` is path-addressed (the URI is the on-disk path under the
 * configured root — a subsequent `put` to the same key replaces the
 * bytes that path resolves to), bytes are retrievable the instant
 * `put` resolves, and `deleteSemantics: 'delete'` means the adapter
 * issues `fs.unlink` for the managed file. Filesystem-level
 * snapshots, backup tooling, or undeletion utilities live outside
 * the adapter contract; AtomicMemory does not assert what they do
 * with the deleted inode.
 */
const CAPABILITIES: RawContentStoreCapabilities = Object.freeze({
  addressing: 'location',
  retrievalConsistency: 'immediate',
  deleteSemantics: 'delete',
  supportsHead: true,
  supportsGet: true,
});

export interface LocalFsRawContentStoreOptions {
  /** Absolute or relative path to the storage root. Resolved at construction. */
  root: string;
}

export class LocalFsRawContentStore implements RawContentStore {
  readonly provider = PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly root: string;

  constructor(options: LocalFsRawContentStoreOptions) {
    if (!options.root || options.root.length === 0) {
      throw new Error('LocalFsRawContentStore: root is required');
    }
    this.root = resolve(options.root);
  }

  async put(input: PutRawContentInput): Promise<StoredRawContent> {
    const target = this.resolveKey(input.key);
    await fs.mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(tmp, input.body);
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    return {
      storageUri: `${URI_PREFIX}${input.key}`,
      storageProvider: PROVIDER,
      contentHash: sha256Hex(input.body),
      sizeBytes: input.body.length,
      status: 'stored',
      providerMetadata: {},
    };
  }

  async get(storageUri: string): Promise<RawContentGetResult> {
    const target = this.resolveUri(storageUri);
    const body = await fs.readFile(target);
    return {
      body,
      metadata: {
        contentLength: body.length,
        contentType: null,
        contentHash: sha256Hex(body),
        providerMetadata: {},
      },
    };
  }

  async head(storageUri: string, _hints?: RawContentHints): Promise<RawContentHeadResult> {
    const target = this.resolveUri(storageUri);
    try {
      const stat = await fs.stat(target);
      return {
        exists: true,
        metadata: {
          contentLength: stat.size,
          contentType: null,
          contentHash: null,
          providerMetadata: { mtime: stat.mtime.toISOString() },
        },
      };
    } catch (err) {
      if (isNotFound(err)) return { exists: false, metadata: null };
      throw err;
    }
  }

  async delete(storageUri: string, _hints?: RawContentHints): Promise<RawContentDeleteResult> {
    const target = this.resolveUri(storageUri);
    try {
      await fs.unlink(target);
      return { deleted: true, semantics: 'deleted' };
    } catch (err) {
      if (isNotFound(err)) return { deleted: false, semantics: 'deleted' };
      throw err;
    }
  }

  private resolveKey(key: string): string {
    if (isAbsolute(key)) {
      throw new RawStorageUriError(`local_fs key must be relative: ${key}`);
    }
    const target = resolve(this.root, key);
    const inside = relative(this.root, target);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new RawStorageUriError(`local_fs key escapes root: ${key}`);
    }
    return target;
  }

  private resolveUri(storageUri: string): string {
    if (!storageUri.startsWith(URI_PREFIX)) {
      throw new RawStorageUriError(`expected local-fs:// URI, got: ${storageUri}`);
    }
    return this.resolveKey(storageUri.slice(URI_PREFIX.length));
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
