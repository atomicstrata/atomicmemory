/**
 * Unit tests for the `local_fs` raw-content adapter.
 *
 * No DB, no network. Each test case operates against a fresh temp dir
 * to keep the suite parallel-safe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalFsRawContentStore,
} from '../local-fs-store.js';
import { RawStorageUriError } from '../raw-content-store.js';

let root: string;
let store: LocalFsRawContentStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomicmem-localfs-'));
  store = new LocalFsRawContentStore({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalFsRawContentStore', () => {
  it('put round-trips body and reports the right hash + size', async () => {
    const body = Buffer.from('hello local-fs', 'utf8');
    const stored = await store.put({ key: 'docs/u1/d1/blob.bin', body });
    expect(stored.storageProvider).toBe('local_fs');
    expect(stored.storageUri).toBe('local-fs://docs/u1/d1/blob.bin');
    expect(stored.sizeBytes).toBe(body.length);
    expect(stored.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const got = await store.get(stored.storageUri);
    expect(Buffer.compare(got.body, body)).toBe(0);
  });

  it('advertises immediate / location / delete capabilities', () => {
    // Locks the Phase-1 lifecycle contract: local_fs is path-addressed
    // (overwrites of the same key replace the bytes the URI resolves
    // to), bytes are retrievable the moment put() returns, and
    // `deleteSemantics: 'delete'` means the adapter issues fs.unlink
    // for the managed file. Filesystem-level snapshots / backups /
    // undeletion utilities are NOT part of this assertion. The upload
    // service reads these to pick raw_storage_status;
    // /v1/documents/limits echoes them to clients.
    expect(store.capabilities).toEqual({
      addressing: 'location',
      retrievalConsistency: 'immediate',
      deleteSemantics: 'delete',
      supportsHead: true,
      supportsGet: true,
    });
  });

  it("put returns status='stored' + empty providerMetadata for the immediate-provider path", async () => {
    const stored = await store.put({ key: 'lifecycle/sentinel.bin', body: Buffer.from('s') });
    expect(stored.status).toBe('stored');
    expect(stored.providerMetadata).toEqual({});
  });

  it('head returns exists=true with the right size, exists=false on miss', async () => {
    const body = Buffer.from('h');
    const stored = await store.put({ key: 'head/exists.bin', body });
    const present = await store.head(stored.storageUri);
    expect(present.exists).toBe(true);
    expect(present.metadata?.contentLength).toBe(1);

    const missing = await store.head('local-fs://head/missing.bin');
    expect(missing.exists).toBe(false);
    expect(missing.metadata).toBeNull();
  });

  it('head + delete ignore the optional RawContentHints arg (non-Filecoin adapters are unaffected)', async () => {
    // The reconciler always passes `row.rawStorageMetadata` as a
    // hints arg to `store.head`. A non-Filecoin adapter must accept
    // (and ignore) it without changing behavior.
    const stored = await store.put({ key: 'hints/ignored.bin', body: Buffer.from('x') });
    const hostileHint = { filecoin: { data_set_id: '99' } };
    const present = await store.head(stored.storageUri, hostileHint);
    expect(present.exists).toBe(true);
    const removed = await store.delete(stored.storageUri, hostileHint);
    expect(removed.deleted).toBe(true);
  });

  it('delete is idempotent: returns {deleted:true} once, {deleted:false} after', async () => {
    const stored = await store.put({ key: 'del/once.bin', body: Buffer.from('x') });
    const first = await store.delete(stored.storageUri);
    expect(first.deleted).toBe(true);
    expect(first.semantics).toBe('deleted');
    const second = await store.delete(stored.storageUri);
    expect(second.deleted).toBe(false);
    // Already-missing still reports `'deleted'` semantics — bytes are
    // gone either way, and the cleanup marker writes blob_deleted.
    expect(second.semantics).toBe('deleted');
  });

  it('rejects URIs that do not start with local-fs://', async () => {
    await expect(store.head('s3://bucket/key')).rejects.toBeInstanceOf(RawStorageUriError);
  });

  it('rejects keys that escape the root via ..', async () => {
    const body = Buffer.from('hax');
    await expect(store.put({ key: '../escape.bin', body })).rejects.toBeInstanceOf(RawStorageUriError);
  });

  it('overwrites cleanly on re-put of the same key', async () => {
    const key = 'over/write.bin';
    await store.put({ key, body: Buffer.from('first') });
    const second = await store.put({ key, body: Buffer.from('second-longer') });
    const got = await store.get(second.storageUri);
    expect(got.body.toString('utf8')).toBe('second-longer');
  });

  it('does not leak the .tmp sibling on success', async () => {
    const key = 'tmp/trail.bin';
    const stored = await store.put({ key, body: Buffer.from('done') });
    const final = stored.storageUri.replace('local-fs://', `${root}/`);
    await expect(stat(final)).resolves.toBeDefined();
    // No .tmp.* file should remain in the parent directory.
    const parent = final.substring(0, final.lastIndexOf('/'));
    const entries = await import('node:fs/promises').then((m) => m.readdir(parent));
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('round-trips an existing file when the directory predates put()', async () => {
    const key = 'pre/existing.bin';
    const dir = join(root, 'pre');
    await import('node:fs/promises').then((m) => m.mkdir(dir, { recursive: true }));
    await writeFile(join(dir, 'placeholder'), 'irrelevant');
    const stored = await store.put({ key, body: Buffer.from('pre-existing') });
    const got = await store.get(stored.storageUri);
    expect(got.body.toString('utf8')).toBe('pre-existing');
  });
});
