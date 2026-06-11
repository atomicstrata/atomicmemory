/**
 * Per-version content-hash tests for the audit trail (radar C7).
 *
 * Asserts that `GET /v1/memories/:id/audit` emits a `content_hash` on every
 * version entry, computed deterministically from the version's content:
 *   - same content   → same hash (stable / content-addressable),
 *   - different content → different hash (distinguishing).
 * The hash is computed in the route formatter from data already loaded, so
 * no extra query and no live Postgres is needed; the mocked-MemoryService +
 * ephemeral-router pattern (shared with memory-route-retrieval-receipt)
 * exercises the real formatter and the dev-mode response-schema validator.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BootedApp, bindEphemeral } from '../app/bind-ephemeral.js';
import { createMemoryRouter } from '../routes/memories.js';
import type { MemoryService } from '../services/memory-service.js';
import type { AuditTrailEntry } from '../db/repository-types.js';

const VALID_FROM = new Date('2026-05-20T10:00:00.000Z');
const MEMORY_ID = '11111111-1111-4111-8111-111111111111';

/** Mirrors computeVersionContentHash in memory-response-formatters.ts. */
function expectedHash(content: string): string {
  return createHash('sha256')
    .update(`radar-claim-version-content:v1\n${content}`)
    .digest('hex');
}

function makeEntry(content: string, versionId: string): AuditTrailEntry {
  return {
    versionId,
    claimId: 'claim-1',
    content,
    mutationType: 'update',
    mutationReason: null,
    actorModel: null,
    contradictionConfidence: null,
    previousVersionId: null,
    supersededByVersionId: null,
    validFrom: VALID_FROM,
    validTo: null,
    memoryId: MEMORY_ID,
  };
}

interface AuditEntryBody {
  content: string;
  content_hash: string;
}

describe('memory audit trail — per-version content hash (radar C7)', () => {
  let booted: BootedApp;
  const mockGetAuditTrail = vi.fn<MemoryService['getAuditTrail']>();
  const service = { getAuditTrail: mockGetAuditTrail } as unknown as MemoryService;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/memories', createMemoryRouter(service));
    booted = await bindEphemeral(app);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await booted.close();
  });

  async function fetchTrail(): Promise<AuditEntryBody[]> {
    const res = await fetch(`${booted.baseUrl}/memories/${MEMORY_ID}/audit?user_id=u`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trail: AuditEntryBody[] };
    return body.trail;
  }

  it('emits a content_hash matching sha256 over the version content', async () => {
    mockGetAuditTrail.mockResolvedValue([makeEntry('the plan is X', 'ver-1')]);
    const [entry] = await fetchTrail();
    expect(entry.content_hash).toBe(expectedHash('the plan is X'));
  });

  it('same content yields the same hash; different content differs', async () => {
    mockGetAuditTrail.mockResolvedValue([
      makeEntry('shared content', 'ver-1'),
      makeEntry('shared content', 'ver-2'),
      makeEntry('other content', 'ver-3'),
    ]);
    const [a, b, c] = await fetchTrail();
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.content_hash).not.toBe(c.content_hash);
  });
});
