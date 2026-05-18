/**
 * @file Compile-time negative-contract tests for the storage artifact
 * type surface. Each `@ts-expect-error` directive proves that a specific shape is
 * REJECTED by the type system today. A future regression that
 * loosens the types would invalidate the directive itself
 * ("unused directive"), failing `pnpm typecheck`.
 *
 * No runtime assertions beyond a `expect(true).toBe(true)` sentinel
 * — the test passes by compiling.
 */

import { describe, it, expect } from 'vitest';
import type {
  ArtifactRef,
  DeleteArtifactOptions,
  PutArtifactInput,
  StorageArtifactStatus,
  StorageCapabilities,
  StoredArtifact,
  VerificationResult,
} from '../index.js';
import {
  ArtifactInUseError,
  ArtifactNotFoundError,
  FilecoinDirectStorageNotSupportedError,
  PointerContentNotManagedError,
  StorageClientError,
  UnsupportedCapabilityError,
} from '../index.js';

describe('Artifact storage — compile-time negative contract', () => {
  it('locks the closed type set against accidental drift', () => {
    // PutArtifactInput is a discriminated union — mixing fields
    // from the two branches must fail.
    // @ts-expect-error - missing `mode`
    const _bad1: PutArtifactInput = { uri: 'https://x', contentType: 'x' };
    void _bad1;

    // @ts-expect-error - `body` belongs to managed mode only
    const _bad2: PutArtifactInput = {
      mode: 'pointer',
      uri: 'https://x',
      contentType: 'x',
      body: Buffer.from(''),
    };
    void _bad2;

    // @ts-expect-error - streams are explicitly rejected (no Readable / ReadableStream in v1)
    const _bad3: PutArtifactInput = {
      mode: 'managed',
      body: new ReadableStream(),
      contentType: 'x',
    };
    void _bad3;

    // DeleteArtifactOptions closed enum — no `force`
    // @ts-expect-error - `force` was removed in rev 5
    const _badDelete: DeleteArtifactOptions = { force: true };
    void _badDelete;
    // @ts-expect-error - random policy strings rejected
    const _badPolicy: DeleteArtifactOptions = { policy: 'with_derived_memories' };
    void _badPolicy;

    // StorageArtifactStatus closed union
    // @ts-expect-error - invalid status
    const _badStatus: StorageArtifactStatus = 'blob_stored';
    void _badStatus;

    // VerificationResult discriminated union
    // @ts-expect-error - missing `reason` on failed
    const _badVerify: VerificationResult = { kind: 'failed' };
    void _badVerify;
    // @ts-expect-error - random kind
    const _badVerify2: VerificationResult = { kind: 'maybe' };
    void _badVerify2;

    // StoredArtifact mode is closed
    // @ts-expect-error - invalid mode
    const _badArtifact: StoredArtifact['mode'] = 'hybrid';
    void _badArtifact;

    // StorageCapabilities has the two new content-addressing axes
    const _caps: StorageCapabilities = {
      provider: 'local_fs',
      addressing: ['location'],
      consistency: 'immediate',
      supportsDirectUpload: true,
      supportsRangeRead: false,
      supportsDelete: true,
      supportsTombstone: false,
      supportsBundles: false,
      supportedBundleFormats: [],
      supportsVerification: false,
      supportsProviderProofs: false,
      supportsReplication: false,
      supportsRetrievalStatus: false,
      supportsContentHash: true,
      supportsContentAddressedUri: false,
      deleteSemantics: ['delete'],
      availabilityModel: 'immediate',
    };
    void _caps;

    // ArtifactRef requires AT LEAST ONE of artifactId/uri/contentHash.
    // @ts-expect-error - empty object does not satisfy the "at least one identifier" rule
    const _badRef: ArtifactRef = {};
    void _badRef;

    // Each individual identifier is a valid ArtifactRef.
    const _refById: ArtifactRef = { artifactId: 'a' };
    void _refById;
    const _refByUri: ArtifactRef = { uri: 'https://example/file' };
    void _refByUri;
    const _refByHash: ArtifactRef = { contentHash: 'abc' };
    void _refByHash;
    // Combinations are also valid.
    const _refMulti: ArtifactRef = {
      artifactId: 'a',
      uri: 'https://example/file',
      contentHash: 'abc',
    };
    void _refMulti;

    expect(true).toBe(true);
  });

  it('exports error classes that are instanceof-checkable', () => {
    const inUse = new ArtifactInUseError({
      artifactId: 'a',
      referencedByDocumentCount: 3,
      bodyText: '{}',
    });
    expect(inUse).toBeInstanceOf(StorageClientError);
    expect(inUse.referencedByDocumentCount).toBe(3);

    const ptr = new PointerContentNotManagedError({
      artifactId: 'a',
      uri: 'https://x',
      bodyText: '{}',
    });
    expect(ptr).toBeInstanceOf(StorageClientError);
    expect(ptr.uri).toBe('https://x');

    const fc = new FilecoinDirectStorageNotSupportedError({ bodyText: '{}' });
    expect(fc).toBeInstanceOf(StorageClientError);
    expect(fc.status).toBe(501);

    const nf = new ArtifactNotFoundError({ artifactId: 'a', bodyText: '{}' });
    expect(nf).toBeInstanceOf(StorageClientError);

    const unsupp = new UnsupportedCapabilityError({
      capability: 'range_read',
      message: 'no',
      bodyText: '{}',
    });
    expect(unsupp.capability).toBe('range_read');
  });
});
