/**
 * Filecoin lifecycle refactor (Slice 4) — composition smoke for
 * `GET /v1/documents/limits` capability advertisement.
 *
 * The Slice 1 storage adapters expose `capabilities`; Slice 4 wires
 * the active `RawContentStore` through `runtime.rawContentStore` →
 * `createApp` → `formatDocumentLimitsResponse` so the wire payload
 * advertises `provider`, `addressing`, `retrieval_consistency`,
 * `delete_semantics`, `supports_head`, `supports_get`. This file
 * locks the seam end-to-end for the three configurations: `local_fs`
 * (location/immediate/delete), `s3` (same triple), and `pointer_only`
 * (no store → capability fields omitted).
 *
 * The composition root `create-app.ts` is the only camelCase→snake_case
 * mapper; this test asserts the wire has snake_case keys AND no
 * camelCase leakage. A regression that emits `retrievalConsistency`
 * on the wire (instead of `retrieval_consistency`) surfaces here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type BootedApp } from '../bind-ephemeral.js';
import { authHeader } from '../../__tests__/helpers/auth-headers.js';
import { useStorageCapabilityFixture } from './helpers/storage-capability-fixture.js';

const fixture = useStorageCapabilityFixture(
  { beforeAll, afterEach, afterAll },
  'atomicmem-limits-caps-',
);

interface CapabilityWireShape {
  enabled: boolean;
  mode: 'pointer_only' | 'managed_blob';
  reason?: string;
  provider?: string;
  addressing?: 'location' | 'content';
  retrieval_consistency?: 'immediate' | 'eventual';
  delete_semantics?: 'delete' | 'unpin' | 'tombstone';
  supports_head?: boolean;
  supports_get?: boolean;
}

async function fetchLimits(app: BootedApp): Promise<{
  raw_upload_max_bytes: number;
  index_max_text_bytes: number;
  raw_storage: CapabilityWireShape;
}> {
  const res = await fetch(`${app.baseUrl}/v1/documents/limits`, { headers: authHeader() });
  expect(res.status).toBe(200);
  return res.json() as Promise<{
    raw_upload_max_bytes: number;
    index_max_text_bytes: number;
    raw_storage: CapabilityWireShape;
  }>;
}

const CAMEL_LEAK_KEYS = [
  'retrievalConsistency',
  'deleteSemantics',
  'supportsHead',
  'supportsGet',
] as const;

function expectNoCamelCaseLeakage(raw: Record<string, unknown>): void {
  for (const k of CAMEL_LEAK_KEYS) {
    expect(raw[k]).toBeUndefined();
  }
}

describe('GET /v1/documents/limits — capability advertisement (Slice 4)', () => {
  it('local_fs: emits the immediate-provider capability triple in snake_case with no camelCase leak', async () => {
    const app = await fixture.bootWith({
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 'local_fs',
      rawStorageLocalFsRoot: fixture.storageRoot(),
    });
    const body = await fetchLimits(app);
    expect(body.raw_storage.enabled).toBe(true);
    expect(body.raw_storage.mode).toBe('managed_blob');
    expect(body.raw_storage.provider).toBe('local_fs');
    expect(body.raw_storage.addressing).toBe('location');
    expect(body.raw_storage.retrieval_consistency).toBe('immediate');
    expect(body.raw_storage.delete_semantics).toBe('delete');
    expect(body.raw_storage.supports_head).toBe(true);
    expect(body.raw_storage.supports_get).toBe(true);
    expectNoCamelCaseLeakage(body.raw_storage as unknown as Record<string, unknown>);
  });

  it('s3: emits the same immediate-provider triple keyed by provider="s3"', async () => {
    const app = await fixture.bootWith({
      rawStorageMode: 'managed_blob',
      rawStorageProvider: 's3',
      rawStorageS3Bucket: 'cap-test-bucket',
      rawStorageS3Region: 'us-east-1',
      rawStorageS3AccessKeyId: 'id',
      rawStorageS3SecretAccessKey: 'secret',
    });
    const body = await fetchLimits(app);
    expect(body.raw_storage.provider).toBe('s3');
    expect(body.raw_storage.addressing).toBe('location');
    expect(body.raw_storage.retrieval_consistency).toBe('immediate');
    expect(body.raw_storage.delete_semantics).toBe('delete');
    expectNoCamelCaseLeakage(body.raw_storage as unknown as Record<string, unknown>);
  });

  it('pointer_only: omits all capability fields and carries the disabled reason', async () => {
    const app = await fixture.bootWith({ rawStorageMode: 'pointer_only', rawStorageProvider: null });
    const body = await fetchLimits(app);
    expect(body.raw_storage.enabled).toBe(false);
    expect(body.raw_storage.mode).toBe('pointer_only');
    expect(body.raw_storage.reason).toMatch(/pointer_only/);
    expect(body.raw_storage.provider).toBeUndefined();
    expect(body.raw_storage.addressing).toBeUndefined();
    expect(body.raw_storage.retrieval_consistency).toBeUndefined();
    expect(body.raw_storage.delete_semantics).toBeUndefined();
    expect(body.raw_storage.supports_head).toBeUndefined();
    expect(body.raw_storage.supports_get).toBeUndefined();
    expectNoCamelCaseLeakage(body.raw_storage as unknown as Record<string, unknown>);
  });
});
