/**
 * @file Route-level tests for `GET /v1/storage/capabilities`.
 *
 * Covers all three managed-blob backends + the pointer-only deployment
 * case + a negative-contract redaction check. Each scenario mounts the
 * storage router on a stand-alone Express app with a synthetic
 * `RawContentStore` snapshot — the route never calls store methods
 * (it only reads `provider`), so a tiny stub is sufficient and avoids
 * the credential surface of real S3 / Filecoin clients.
 */

import express, { type Express } from 'express';
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createStorageRouter } from '../storage.js';
import { formatDocumentLimitsResponse } from '../document-response-formatters.js';
import { getStorageCapabilities } from '../../storage/storage-capabilities.js';
import type { RawContentStore } from '../../storage/raw-content-store.js';
import type {
  RawContentStoreCapabilities,
} from '../../storage/raw-content-store.js';
import type { StorageCapabilitiesSnapshot } from '../../storage/storage-capabilities.js';
import type { StorageService } from '../../services/storage-service.js';
import {
  closeEphemeralServer,
  startEphemeralServer,
} from './ephemeral-server.js';

const TEST_RAW_UPLOAD_MAX_BYTES = 26214400;

interface SuiteHandle {
  baseUrl: string;
  server: Server;
}

async function mountStorageRouter(
  snapshot: StorageCapabilitiesSnapshot,
): Promise<SuiteHandle> {
  const app: Express = express();
  app.use(express.json());
  // The capabilities route never touches the service or upload cap;
  // we pass stubs here so the router signature is satisfied without
  // booting a real DB. CRUD-route coverage lives in
  // storage-routes.test.ts and storage-capabilities-app.test.ts.
  const serviceStub = {} as StorageService;
  app.use(
    '/v1/storage',
    createStorageRouter({
      capabilities: snapshot,
      service: serviceStub,
      managedUploadMaxBytes: 1024 * 1024,
    }),
  );
  return startEphemeralServer(app);
}

const closeServer = closeEphemeralServer;

function fakeStore(
  provider: string,
  capabilities?: RawContentStoreCapabilities,
): RawContentStore {
  return {
    provider,
    capabilities: capabilities ?? {
      addressing: 'location',
      retrievalConsistency: 'immediate',
      deleteSemantics: 'delete',
      supportsHead: true,
      supportsGet: true,
    },
    put: async () => {
      throw new Error('test stub: not implemented');
    },
    get: async () => {
      throw new Error('test stub: not implemented');
    },
    head: async () => {
      throw new Error('test stub: not implemented');
    },
    delete: async () => {
      throw new Error('test stub: not implemented');
    },
  };
}

const FILECOIN_RAW_CAPABILITIES: RawContentStoreCapabilities = {
  addressing: 'content',
  retrievalConsistency: 'eventual',
  deleteSemantics: 'tombstone',
  supportsHead: true,
  supportsGet: true,
};

async function fetchCapabilities(baseUrl: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${baseUrl}/v1/storage/capabilities`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /v1/storage/capabilities', () => {
  it.each(['local_fs', 's3'])(
    '%s: reports direct upload + content-hash supported, no content-addressed URI',
    async (provider) => {
      const handle = await mountStorageRouter({
        activeStore: fakeStore(provider),
        rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
      });
      try {
        const { status, body } = await fetchCapabilities(handle.baseUrl);
        expect(status).toBe(200);
        expect(body.provider).toBe(provider);
        expect(body.supportsDirectUpload).toBe(true);
        expect(body.supportsContentHash).toBe(true);
        expect(body.supportsContentAddressedUri).toBe(false);
        expect(body.addressing).toEqual(['location']);
        expect(body.consistency).toBe('immediate');
        expect(body.deleteSemantics).toEqual(['delete']);
        expect(body.availabilityModel).toBe('immediate');
        expect(body.maxUploadBytes).toBe(TEST_RAW_UPLOAD_MAX_BYTES);
        // the storage-route implementation ships the verify route + backend.head() shim.
        expect(body.supportsVerification).toBe(true);
      } finally {
        await closeServer(handle.server);
      }
    },
  );

  it.each(['mystery_backend'])(
    'unknown provider %s: fails closed — no direct upload, no content hash, no delete',
    async (provider) => {
      const handle = await mountStorageRouter({
        activeStore: fakeStore(provider),
        rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
      });
      try {
        const { status, body } = await fetchCapabilities(handle.baseUrl);
        expect(status).toBe(200);
        // Provider name preserved so operators see what is configured…
        expect(body.provider).toBe(provider);
        // …but every direct-API capability is false until the provider
        // is explicitly added to the `getStorageCapabilities` switch.
        expect(body.supportsDirectUpload).toBe(false);
        expect(body.supportsContentHash).toBe(false);
        expect(body.supportsContentAddressedUri).toBe(false);
        expect(body.supportsDelete).toBe(false);
        expect(body.supportsVerification).toBe(false);
        expect(body.supportsTombstone).toBe(false);
        expect(body.addressing).toEqual([]);
        expect(body.deleteSemantics).toEqual([]);
        expect(body.maxUploadBytes).toBeUndefined();
      } finally {
        await closeServer(handle.server);
      }
    },
  );

  it('filecoin: every direct-API supports* flag is false in v1 (direct upload is 501)', async () => {
    const handle = await mountStorageRouter({
      activeStore: fakeStore('filecoin', FILECOIN_RAW_CAPABILITIES),
      rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
    });
    try {
      const { status, body } = await fetchCapabilities(handle.baseUrl);
      expect(status).toBe(200);
      expect(body.provider).toBe('filecoin');
      expect(body.supportsDirectUpload).toBe(false);
      expect(body.supportsContentHash).toBe(false);
      expect(body.supportsContentAddressedUri).toBe(false);
      expect(body.supportsDelete).toBe(false);
      expect(body.supportsVerification).toBe(false);
      expect(body.supportsProviderProofs).toBe(false);
      expect(body.supportsReplication).toBe(false);
      expect(body.supportsRetrievalStatus).toBe(false);
      expect(body.supportsTombstone).toBe(false);
      expect(body.supportsBundles).toBe(false);
      expect(body.supportsRangeRead).toBe(false);
      expect(body.consistency).toBe('eventual');
      expect(body.availabilityModel).toBe('delayed');
      expect(body.addressing).toEqual([]);
      expect(body.deleteSemantics).toEqual([]);
      expect(body.maxUploadBytes).toBeUndefined();
    } finally {
      await closeServer(handle.server);
    }
  });

  it('pointer-only deployment (no active store): provider=none, all capabilities false', async () => {
    const handle = await mountStorageRouter({
      activeStore: null,
      rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
    });
    try {
      const { status, body } = await fetchCapabilities(handle.baseUrl);
      expect(status).toBe(200);
      expect(body.provider).toBe('none');
      expect(body.supportsDirectUpload).toBe(false);
      expect(body.supportsContentHash).toBe(false);
      expect(body.supportsContentAddressedUri).toBe(false);
      expect(body.maxUploadBytes).toBeUndefined();
    } finally {
      await closeServer(handle.server);
    }
  });

  it('filecoin cross-endpoint contract: same RawContentStore yields false direct-API caps AND content/eventual/tombstone document-ingestion caps', () => {
    // A single Filecoin-shaped RawContentStore must drive BOTH:
    //   - direct storage API → every supports* false (v1 carve-out)
    //   - document-ingestion → unchanged content/eventual/tombstone
    // Booting a real Filecoin runtime requires Filecoin provider credentials, so we
    // exercise the two formatter functions directly against the same
    // store. the storage-route implementation / app-level wiring inherits the same coherence.
    const store = fakeStore('filecoin', FILECOIN_RAW_CAPABILITIES);
    const storageCaps = getStorageCapabilities({
      activeStore: store,
      rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
    });
    expect(storageCaps.provider).toBe('filecoin');
    expect(storageCaps.supportsDirectUpload).toBe(false);
    expect(storageCaps.supportsContentHash).toBe(false);
    expect(storageCaps.supportsContentAddressedUri).toBe(false);

    const limits = formatDocumentLimitsResponse({
      rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
      indexMaxTextBytes: 25 * 1024 * 1024,
      rawStorage: {
        enabled: true,
        mode: 'managed_blob',
        provider: store.provider,
        capabilities: store.capabilities,
      },
    });
    const rawStorage = limits.raw_storage as Record<string, unknown>;
    expect(rawStorage.provider).toBe('filecoin');
    expect(rawStorage.addressing).toBe('content');
    expect(rawStorage.retrieval_consistency).toBe('eventual');
    expect(rawStorage.delete_semantics).toBe('tombstone');
    expect(rawStorage.supports_head).toBe(true);
    expect(rawStorage.supports_get).toBe(true);
  });

  it('redaction: response shape is the closed allowlist — no internal fields leak', async () => {
    const handle = await mountStorageRouter({
      activeStore: fakeStore('local_fs'),
      rawUploadMaxBytes: TEST_RAW_UPLOAD_MAX_BYTES,
    });
    try {
      const { body } = await fetchCapabilities(handle.baseUrl);
      const allowedKeys = new Set([
        'provider',
        'addressing',
        'consistency',
        'maxUploadBytes',
        'minUploadBytes',
        'supportsDirectUpload',
        'supportsRangeRead',
        'supportsDelete',
        'supportsTombstone',
        'supportsBundles',
        'supportedBundleFormats',
        'supportsVerification',
        'supportsProviderProofs',
        'supportsReplication',
        'supportsRetrievalStatus',
        'supportsContentHash',
        'supportsContentAddressedUri',
        'deleteSemantics',
        'availabilityModel',
      ]);
      for (const key of Object.keys(body)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
      // Internal raw-content-store fields must not leak through.
      expect(body).not.toHaveProperty('retrievalConsistency');
      expect(body).not.toHaveProperty('supportsHead');
      expect(body).not.toHaveProperty('supportsGet');
    } finally {
      await closeServer(handle.server);
    }
  });
});
