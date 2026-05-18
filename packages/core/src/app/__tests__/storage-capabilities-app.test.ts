/**
 * @file App-level smoke for the direct storage API capabilities surface.
 *
 * Asserts the storage router IS wired through `createApp` and the
 * snapshot it advertises is the same `runtime.rawContentStore` that
 * `/v1/documents/limits` reads. Mirrors the pattern in
 * `document-limits-capabilities.test.ts` so a regression in either
 * `create-app.ts` wiring surfaces here.
 *
 * Filecoin gets covered by the formatter-level cross-endpoint test in
 * `src/routes/__tests__/storage-capabilities-route.test.ts` — booting
 * a real Filecoin runtime requires Storacha credentials that the test
 * env does not carry, but the same `RawContentStore` fed into the two
 * formatter functions proves the cross-endpoint contract for Filecoin
 * deterministically.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config as defaultConfig } from '../../config.js';
import { type BootedApp } from '../bind-ephemeral.js';
import { authHeader } from '../../__tests__/helpers/auth-headers.js';
import { useStorageCapabilityFixture } from './helpers/storage-capability-fixture.js';

const fixture = useStorageCapabilityFixture(
  { beforeAll, afterEach, afterAll },
  'atomicmem-storage-caps-',
);

interface StorageCapabilitiesBody {
  provider: string;
  supportsDirectUpload: boolean;
  supportsContentHash: boolean;
  supportsContentAddressedUri: boolean;
  supportsDelete: boolean;
  supportsVerification: boolean;
  maxUploadBytes?: number;
  addressing: string[];
  consistency: string;
  deleteSemantics: string[];
}

interface DocumentLimitsRawStorageBody {
  enabled: boolean;
  mode: string;
  provider?: string;
  addressing?: string;
  retrieval_consistency?: string;
  delete_semantics?: string;
  supports_head?: boolean;
  supports_get?: boolean;
}

async function fetchStorageCapabilities(app: BootedApp): Promise<StorageCapabilitiesBody> {
  const res = await fetch(`${app.baseUrl}/v1/storage/capabilities`, {
    headers: authHeader(),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<StorageCapabilitiesBody>;
}

async function fetchDocumentLimits(
  app: BootedApp,
): Promise<{ raw_storage: DocumentLimitsRawStorageBody }> {
  const res = await fetch(`${app.baseUrl}/v1/documents/limits`, {
    headers: authHeader(),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ raw_storage: DocumentLimitsRawStorageBody }>;
}

describe('GET /v1/storage/capabilities — app-level wiring', () => {
  it('local_fs: capabilities route is reachable AND shares runtime.rawContentStore with documents/limits', async () => {
    const app = await fixture.bootWith({
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 'local_fs',
      rawStorageLocalFsRoot: fixture.storageRoot(),
    });
    const [storage, limits] = await Promise.all([
      fetchStorageCapabilities(app),
      fetchDocumentLimits(app),
    ]);
    // Same active store backs both surfaces — provider matches.
    expect(storage.provider).toBe('local_fs');
    expect(limits.raw_storage.provider).toBe('local_fs');
    // Direct API claims for local_fs.
    expect(storage.supportsDirectUpload).toBe(true);
    expect(storage.supportsContentHash).toBe(true);
    expect(storage.supportsDelete).toBe(true);
    expect(storage.addressing).toEqual(['location']);
    expect(storage.consistency).toBe('immediate');
    expect(storage.maxUploadBytes).toBe(defaultConfig.rawUploadMaxBytes);
    // Document-ingestion surface keeps reporting the underlying
    // RawContentStore capabilities (immediate/location/delete for local_fs).
    expect(limits.raw_storage.addressing).toBe('location');
    expect(limits.raw_storage.retrieval_consistency).toBe('immediate');
    expect(limits.raw_storage.delete_semantics).toBe('delete');
  });

  it('pointer_only: storage capabilities reports provider=none; documents/limits omits provider', async () => {
    const app = await fixture.bootWith({ rawStorageMode: 'pointer_only', rawStorageProvider: null });
    const [storage, limits] = await Promise.all([
      fetchStorageCapabilities(app),
      fetchDocumentLimits(app),
    ]);
    expect(storage.provider).toBe('none');
    expect(storage.supportsDirectUpload).toBe(false);
    expect(storage.supportsContentHash).toBe(false);
    expect(storage.supportsDelete).toBe(false);
    expect(limits.raw_storage.enabled).toBe(false);
    expect(limits.raw_storage.provider).toBeUndefined();
  });
});
